import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import sharp from 'sharp'

const WIDTH = 1280
const HEIGHT = 720
const FRAME_COUNT = 72
const FPS = 10

const root = resolve(import.meta.dirname, '..')
const backgroundPath = resolve(root, 'public/demos/project-status-progress-base.png')
const outputPath = resolve(root, 'public/demos/project-status-progress.gif')
const frameDir = mkdtempSync(join(tmpdir(), 'tracking-gantt-status-gif-'))

const tasks = [
  { name: '需求确认与计划', start: 0.02, end: 0.20, color: '#4F8EF7' },
  { name: '方案设计与准备', start: 0.15, end: 0.38, color: '#6173E8' },
  { name: '核心任务实施', start: 0.32, end: 0.63, color: '#12A8B4' },
  { name: '联调测试与验收', start: 0.57, end: 0.83, color: '#16B884' },
  { name: '上线交付与转维', start: 0.80, end: 0.97, color: '#1FA66A' },
]

const clamp = (value, min = 0, max = 1) => Math.max(min, Math.min(max, value))
const easeInOut = value => value < 0.5
  ? 4 * value * value * value
  : 1 - Math.pow(-2 * value + 2, 3) / 2

function taskProgress(task, statusProgress) {
  return clamp((statusProgress - task.start) / (task.end - task.start))
}

function phaseLabel(progress) {
  if (progress >= 1) return '项目完成'
  if (progress >= 0.8) return '收尾验收'
  if (progress >= 0.55) return '交付冲刺'
  if (progress >= 0.18) return '执行跟进'
  return '项目启动'
}

function checkIcon(cx, cy, color = '#FFFFFF') {
  return `<path d="M ${cx - 6} ${cy} l 4 4 l 9 -10" fill="none" stroke="${color}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>`
}

function frameSvg(progress, frameIndex) {
  const chartX = 340
  const chartRight = 1110
  const chartWidth = chartRight - chartX
  const statusX = chartX + chartWidth * progress
  const statusDay = 1 + Math.round(progress * 13)
  const progresses = tasks.map(task => taskProgress(task, progress))
  const completedCount = progresses.filter(value => value >= 1).length
  const overallProgress = Math.round(progresses.reduce((sum, value) => sum + value, 0) / tasks.length * 100)
  const statusLabelX = clamp(statusX - 66, chartX, chartRight - 132)
  const complete = progress >= 1

  const dateLabels = Array.from({ length: 8 }, (_, index) => {
    const x = chartX + chartWidth * index / 7
    const day = 1 + Math.round(index * 13 / 7)
    return `<text x="${x}" y="224" text-anchor="middle" class="axis">8/${String(day).padStart(2, '0')}</text>`
  }).join('')

  const gridLines = Array.from({ length: 8 }, (_, index) => {
    const x = chartX + chartWidth * index / 7
    return `<line x1="${x}" y1="235" x2="${x}" y2="525" stroke="#DCE7F5" stroke-width="1" stroke-dasharray="4 6"/>`
  }).join('')

  const taskRows = tasks.map((task, index) => {
    const y = 252 + index * 56
    const barX = chartX + task.start * chartWidth
    const barWidth = (task.end - task.start) * chartWidth
    const fillWidth = Math.max(0, barWidth * progresses[index])
    const done = progresses[index] >= 1
    const active = progresses[index] > 0 && !done
    const state = done ? '已完成' : active ? '进行中' : '待开始'
    const stateColor = done ? '#149C69' : active ? '#3D77E8' : '#91A2B8'

    return `
      <rect x="165" y="${y - 11}" width="950" height="44" rx="12" fill="${index % 2 ? '#F8FAFD' : '#FFFFFF'}"/>
      <circle cx="184" cy="${y + 11}" r="11" fill="${done ? '#20B77A' : active ? '#4F8EF7' : '#D7E1EE'}"/>
      ${done ? checkIcon(184, y + 11) : `<text x="184" y="${y + 15}" text-anchor="middle" class="row-index">${index + 1}</text>`}
      <text x="205" y="${y + 7}" class="task-name">${task.name}</text>
      <text x="205" y="${y + 24}" class="task-state" fill="${stateColor}">${state}</text>
      <rect x="${barX}" y="${y}" width="${barWidth}" height="22" rx="11" fill="#DFE8F3"/>
      <rect x="${barX}" y="${y}" width="${fillWidth}" height="22" rx="11" fill="${task.color}"/>
      ${active ? `<circle cx="${barX + fillWidth}" cy="${y + 11}" r="6" fill="#FFFFFF" stroke="${task.color}" stroke-width="3"/>` : ''}
      ${done ? `<circle cx="${barX + barWidth - 11}" cy="${y + 11}" r="8" fill="#FFFFFF" opacity="0.95"/>${checkIcon(barX + barWidth - 11, y + 11, task.color)}` : ''}
    `
  }).join('')

  const confetti = complete
    ? Array.from({ length: 14 }, (_, index) => {
        const x = 410 + (index * 67) % 610
        const y = 91 + (index % 3) * 22 + Math.sin(frameIndex * 0.35 + index) * 5
        const color = ['#4F8EF7', '#16B884', '#F6B94A'][index % 3]
        return `<circle cx="${x}" cy="${y}" r="${2 + index % 3}" fill="${color}" opacity="0.75"/>`
      }).join('')
    : ''

  return `
  <svg width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <style>
        text { font-family: "PingFang SC", "Hiragino Sans GB", "Arial Unicode MS", sans-serif; }
        .title { font-size: 27px; font-weight: 700; fill: #18304F; letter-spacing: 0.5px; }
        .subtitle { font-size: 14px; font-weight: 400; fill: #71829A; }
        .axis { font-size: 12px; fill: #8393AA; }
        .task-name { font-size: 15px; font-weight: 600; fill: #243A58; }
        .task-state { font-size: 11px; font-weight: 600; }
        .row-index { font-size: 10px; font-weight: 700; fill: #FFFFFF; }
        .metric-label { font-size: 11px; fill: #8191A7; }
        .metric-value { font-size: 18px; font-weight: 700; fill: #253D5C; }
      </style>
      <filter id="softShadow" x="-20%" y="-20%" width="140%" height="140%">
        <feDropShadow dx="0" dy="4" stdDeviation="8" flood-color="#47698F" flood-opacity="0.15"/>
      </filter>
      <linearGradient id="progressGradient" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stop-color="#4F8EF7"/>
        <stop offset="1" stop-color="#16B884"/>
      </linearGradient>
    </defs>

    <rect x="151" y="71" width="985" height="565" rx="26" fill="#FFFFFF" fill-opacity="0.93"/>
    <text x="170" y="116" class="title">状态日期驱动项目全过程</text>
    <text x="170" y="144" class="subtitle">计划制定 → 状态跟进 → 任务完成 → 项目交付</text>

    <rect x="942" y="91" width="174" height="48" rx="24" fill="${complete ? '#E9FAF3' : '#EEF4FF'}"/>
    <circle cx="969" cy="115" r="15" fill="${complete ? '#20B77A' : '#4F8EF7'}"/>
    ${complete ? checkIcon(969, 115) : `<path d="M969 105 A10 10 0 ${overallProgress > 50 ? 1 : 0} 1 960 120" fill="none" stroke="#FFFFFF" stroke-width="3" stroke-linecap="round"/>`}
    <text x="992" y="111" class="metric-label">项目进度</text>
    <text x="992" y="130" class="metric-value">${overallProgress}%</text>

    <rect x="170" y="168" width="946" height="38" rx="19" fill="#F1F5FA"/>
    <rect x="170" y="168" width="${Math.max(38, 946 * progress)}" height="38" rx="19" fill="url(#progressGradient)" opacity="0.95"/>
    <text x="190" y="193" font-size="13" font-weight="650" fill="${progress > 0.12 ? '#FFFFFF' : '#334D6D'}">${phaseLabel(progress)}</text>
    ${complete ? `<text x="1092" y="193" text-anchor="end" font-size="13" font-weight="700" fill="#FFFFFF">全部任务完成 · 正式交付</text>` : ''}

    <text x="165" y="224" class="axis">主要任务</text>
    ${dateLabels}
    ${gridLines}
    ${taskRows}

    <line x1="${statusX}" y1="218" x2="${statusX}" y2="525" stroke="#E65C73" stroke-width="3"/>
    <circle cx="${statusX}" cy="218" r="6" fill="#FFFFFF" stroke="#E65C73" stroke-width="3"/>
    <rect x="${statusLabelX}" y="199" width="132" height="27" rx="13.5" fill="#E65C73" filter="url(#softShadow)"/>
    <text x="${statusLabelX + 66}" y="218" text-anchor="middle" font-size="12" font-weight="700" fill="#FFFFFF">状态日期 8月${String(statusDay).padStart(2, '0')}日</text>

    <rect x="170" y="551" width="288" height="62" rx="16" fill="#F5F8FC"/>
    <text x="190" y="574" class="metric-label">任务完成</text>
    <text x="190" y="599" class="metric-value">${completedCount} / ${tasks.length}</text>
    <circle cx="426" cy="582" r="17" fill="${complete ? '#20B77A' : '#DCE7F5'}"/>
    ${complete ? checkIcon(426, 582) : ''}

    <rect x="476" y="551" width="288" height="62" rx="16" fill="#F5F8FC"/>
    <text x="496" y="574" class="metric-label">当前状态日期</text>
    <text x="496" y="599" class="metric-value">8月${String(statusDay).padStart(2, '0')}日</text>

    <rect x="782" y="551" width="334" height="62" rx="16" fill="${complete ? '#ECFAF4' : '#F5F8FC'}"/>
    <text x="802" y="574" class="metric-label">项目结果</text>
    <text x="802" y="599" class="metric-value" fill="${complete ? '#159668' : '#253D5C'}">${complete ? '按计划完成并交付' : '持续跟踪，按计划推进'}</text>
    ${confetti}
  </svg>`
}

async function main() {
  const background = await sharp(readFileSync(backgroundPath))
    .resize(WIDTH, HEIGHT, { fit: 'cover' })
    .png()
    .toBuffer()

  try {
    for (let index = 0; index < FRAME_COUNT; index += 1) {
      const linear = clamp(index / 57)
      const progress = easeInOut(linear)
      const framePath = join(frameDir, `frame-${String(index).padStart(3, '0')}.png`)
      await sharp(background)
        .composite([{ input: Buffer.from(frameSvg(progress, index)) }])
        .png({ compressionLevel: 9 })
        .toFile(framePath)
    }

    const palettePath = join(frameDir, 'palette.png')
    execFileSync('ffmpeg', [
      '-y', '-loglevel', 'error', '-framerate', String(FPS),
      '-i', join(frameDir, 'frame-%03d.png'),
      '-vf', 'palettegen=max_colors=160:stats_mode=diff',
      palettePath,
    ], { stdio: 'inherit' })

    execFileSync('ffmpeg', [
      '-y', '-loglevel', 'error', '-framerate', String(FPS),
      '-i', join(frameDir, 'frame-%03d.png'),
      '-i', palettePath,
      '-lavfi', 'paletteuse=dither=sierra2_4a:diff_mode=rectangle',
      '-loop', '0', outputPath,
    ], { stdio: 'inherit' })
  } finally {
    if (frameDir.startsWith(tmpdir())) rmSync(frameDir, { recursive: true, force: true })
  }

  console.log(outputPath)
}

await main()
