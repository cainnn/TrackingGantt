import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import sharp from 'sharp'

const WIDTH = 1280
const HEIGHT = 720
const FPS = 10
const FRAMES_PER_STATE = 14
const FINAL_HOLD_FRAMES = 12

const root = resolve(import.meta.dirname, '..')
const backgroundPath = resolve(root, 'public/demos/cdn-12-zte-project-status-base.png')
const outputPath = resolve(root, 'public/demos/cdn-12-zte-project-status-progress.gif')
const frameDir = mkdtempSync(join(tmpdir(), 'cdn-12-zte-status-gif-'))

// Read from VPS project 842a2857-940d-4480-baa7-8181b756263b on 2026-08-28.
// The first five states are persisted status-date snapshots; the last is the
// current project state on the VPS, whose status date is 2026-05-29.
const taskDefinitions = [
  { code: '41', name: '27台服务器提供和节点建设方案', color: '#4F8EF7' },
  { code: '51', name: '设备接入集团网络', color: '#6079E8' },
  { code: '40', name: '集团入网', color: '#3B9BD8' },
  { code: '42', name: '上线前业务测试', color: '#1BAAB7' },
  { code: '70', name: '2C功能升级', color: '#19A98D' },
  { code: '117', name: '节点连通性测试，上线前测试', color: '#1FB67D' },
  { code: '118', name: '节点上线', color: '#25A66F' },
  { code: '87', name: '工程完成', color: '#158C62', milestone: true },
]

const states = [
  {
    version: '#69', date: '2026-04-11', completed: 22, total: 48,
    plannedFinish: '2026-05-27', note: '首个状态快照',
    dates: {
      41: ['2026-03-04', '2026-03-06'], 51: ['2026-03-10', '2026-03-14'],
      40: ['2026-03-20', '2026-04-11'], 42: ['2026-04-15', '2026-04-22'],
      70: ['2026-03-16', '2026-05-27'], 117: ['2026-05-07', '2026-05-09'],
      118: ['2026-05-19', '2026-05-20'], 87: ['2026-05-27', '2026-05-27'],
    },
  },
  {
    version: '#70', date: '2026-04-12', completed: 22, total: 48,
    plannedFinish: '2026-05-30', note: '计划复核',
    dates: {
      41: ['2026-03-04', '2026-03-06'], 51: ['2026-03-10', '2026-03-14'],
      40: ['2026-03-20', '2026-04-11'], 42: ['2026-04-15', '2026-04-22'],
      70: ['2026-03-16', '2026-05-30'], 117: ['2026-05-07', '2026-05-09'],
      118: ['2026-05-19', '2026-05-20'], 87: ['2026-05-30', '2026-05-30'],
    },
  },
  {
    version: '#71', date: '2026-04-16', completed: 25, total: 48,
    plannedFinish: '2026-05-30', note: '阶段推进',
    dates: {
      41: ['2026-03-04', '2026-03-06'], 51: ['2026-03-10', '2026-03-14'],
      40: ['2026-03-20', '2026-04-11'], 42: ['2026-04-15', '2026-04-22'],
      70: ['2026-03-16', '2026-05-30'], 117: ['2026-05-07', '2026-05-09'],
      118: ['2026-05-19', '2026-05-20'], 87: ['2026-05-30', '2026-05-30'],
    },
  },
  {
    version: '#73', date: '2026-04-23', completed: 28, total: 45,
    plannedFinish: '2026-05-31', note: '计划调整',
    dates: {
      41: ['2026-03-04', '2026-03-06'], 51: ['2026-03-10', '2026-03-14'],
      40: ['2026-03-20', '2026-04-11'], 42: ['2026-04-15', '2026-05-01'],
      70: ['2026-03-16', '2026-05-30'], 117: ['2026-05-07', '2026-05-09'],
      118: ['2026-05-19', '2026-05-20'], 87: ['2026-05-31', '2026-05-31'],
    },
  },
  {
    version: '#74', date: '2026-05-14', completed: 36, total: 45,
    plannedFinish: '2026-05-31', note: '上线冲刺',
    dates: {
      41: ['2026-03-04', '2026-03-06'], 51: ['2026-03-10', '2026-03-14'],
      40: ['2026-03-20', '2026-04-11'], 42: ['2026-04-15', '2026-05-01'],
      70: ['2026-03-16', '2026-05-30'], 117: ['2026-05-07', '2026-05-09'],
      118: ['2026-05-19', '2026-05-20'], 87: ['2026-05-31', '2026-05-31'],
    },
  },
  {
    version: '当前', date: '2026-05-29', completed: 43, total: 43,
    plannedFinish: '2026-05-27', note: '项目完成', current: true,
    dates: {
      41: ['2026-03-22', '2026-03-24'], 51: ['2026-03-28', '2026-04-01'],
      40: ['2026-04-06', '2026-04-28'], 42: ['2026-05-02', '2026-05-18'],
      70: ['2026-04-26', '2026-05-26'], 117: ['2026-05-20', '2026-05-22'],
      118: ['2026-05-26', '2026-05-27'], 87: ['2026-05-27', '2026-05-27'],
    },
  },
]

const RANGE_START = Date.parse('2026-03-04T00:00:00Z')
const RANGE_END = Date.parse('2026-05-31T00:00:00Z')

const clamp = (value, min = 0, max = 1) => Math.max(min, Math.min(max, value))
const easeOut = value => 1 - Math.pow(1 - value, 3)
const parseDay = value => Date.parse(`${value}T00:00:00Z`)
const lerp = (a, b, amount) => a + (b - a) * amount
const xForDate = (value, chartX, chartWidth) => chartX
  + clamp((parseDay(value) - RANGE_START) / (RANGE_END - RANGE_START)) * chartWidth

function formatDate(value) {
  const [, month, day] = value.split('-')
  return `${Number(month)}月${Number(day)}日`
}

function checkIcon(cx, cy, color = '#FFFFFF', scale = 1) {
  return `<path d="M ${cx - 6 * scale} ${cy} l ${4 * scale} ${4 * scale} l ${9 * scale} ${-10 * scale}" fill="none" stroke="${color}" stroke-width="${3 * scale}" stroke-linecap="round" stroke-linejoin="round"/>`
}

function taskProgress(start, end, statusDate) {
  const startMs = parseDay(start)
  const endMs = parseDay(end)
  const statusMs = parseDay(statusDate)
  if (startMs === endMs) return statusMs >= endMs ? 1 : 0
  return clamp((statusMs - startMs) / (endMs - startMs))
}

function finishChange(index) {
  if (index === 0) return '初始计划'
  const current = parseDay(states[index].plannedFinish)
  const previous = parseDay(states[index - 1].plannedFinish)
  const days = Math.round((current - previous) / 86_400_000)
  if (days > 0) return `较上次推迟${days}天`
  if (days < 0) return `较上次提前${Math.abs(days)}天`
  return '较上次不变'
}

function frameSvg(stateIndex, localFrame) {
  const state = states[stateIndex]
  const previous = states[Math.max(0, stateIndex - 1)]
  const morph = stateIndex === 0 ? 1 : easeOut(clamp(localFrame / 5))
  const chartX = 402
  const chartRight = 1120
  const chartWidth = chartRight - chartX
  const statusX = xForDate(state.date, chartX, chartWidth)
  const progressPercent = Math.round(state.completed / state.total * 100)
  const complete = state.completed === state.total

  const dateTicks = [
    ['2026-03-04', '3/04'], ['2026-03-20', '3/20'], ['2026-04-05', '4/05'],
    ['2026-04-21', '4/21'], ['2026-05-07', '5/07'], ['2026-05-23', '5/23'],
    ['2026-05-31', '5/31'],
  ]

  const axisLabels = dateTicks.map(([date, label]) => {
    const x = xForDate(date, chartX, chartWidth)
    return `<text x="${x}" y="241" text-anchor="middle" class="axis">${label}</text>`
  }).join('')

  const gridLines = dateTicks.map(([date]) => {
    const x = xForDate(date, chartX, chartWidth)
    return `<line x1="${x}" y1="249" x2="${x}" y2="568" stroke="#DCE7F5" stroke-width="1" stroke-dasharray="4 6"/>`
  }).join('')

  const snapshotTrack = states.map((item, index) => {
    const x = 246 + index * 162
    const reached = index <= stateIndex
    const active = index === stateIndex
    return `
      ${index > 0 ? `<line x1="${x - 162}" y1="179" x2="${x}" y2="179" stroke="${reached ? '#58A7E8' : '#D9E4F1'}" stroke-width="4"/>` : ''}
      <circle cx="${x}" cy="179" r="${active ? 10 : 7}" fill="${reached ? (active ? '#E65C73' : '#4F8EF7') : '#D9E4F1'}" stroke="#FFFFFF" stroke-width="3"/>
      <text x="${x}" y="161" text-anchor="middle" class="snapshot-date" fill="${active ? '#C94962' : reached ? '#526A88' : '#9DABBD'}">${formatDate(item.date).replace('月', '/').replace('日', '')}</text>
    `
  }).join('')

  const taskRows = taskDefinitions.map((task, index) => {
    const y = 258 + index * 38
    const previousDates = previous.dates[task.code]
    const currentDates = state.dates[task.code]
    const startMs = lerp(parseDay(previousDates[0]), parseDay(currentDates[0]), morph)
    const endMs = lerp(parseDay(previousDates[1]), parseDay(currentDates[1]), morph)
    const start = new Date(startMs).toISOString().slice(0, 10)
    const end = new Date(endMs).toISOString().slice(0, 10)
    const barX = xForDate(start, chartX, chartWidth)
    const barEndX = xForDate(end, chartX, chartWidth)
    const barWidth = Math.max(task.milestone ? 0 : 16, barEndX - barX)
    const progress = taskProgress(start, end, state.date)
    const done = progress >= 1
    const active = progress > 0 && !done
    const stateText = done ? '已完成' : active ? '进行中' : '未开始'
    const stateColor = done ? '#149C69' : active ? '#3D77E8' : '#91A2B8'

    if (task.milestone) {
      const diamondX = barX
      return `
        <rect x="164" y="${y - 7}" width="956" height="34" rx="10" fill="${index % 2 ? '#F8FAFD' : '#FFFFFF'}"/>
        <text x="178" y="${y + 3}" class="task-code">${task.code}</text>
        <text x="213" y="${y + 3}" class="task-name">${task.name}</text>
        <text x="213" y="${y + 18}" class="task-state" fill="${stateColor}">${stateText}</text>
        <path d="M ${diamondX} ${y - 3} l 13 13 l -13 13 l -13 -13 z" fill="${done ? task.color : '#D7E1EE'}"/>
        ${done ? checkIcon(diamondX, y + 10, '#FFFFFF', 0.8) : ''}
      `
    }

    const fillWidth = Math.max(0, barWidth * progress)
    return `
      <rect x="164" y="${y - 7}" width="956" height="34" rx="10" fill="${index % 2 ? '#F8FAFD' : '#FFFFFF'}"/>
      <text x="178" y="${y + 3}" class="task-code">${task.code}</text>
      <text x="213" y="${y + 3}" class="task-name">${task.name}</text>
      <text x="213" y="${y + 18}" class="task-state" fill="${stateColor}">${stateText}</text>
      <rect x="${barX}" y="${y - 1}" width="${barWidth}" height="20" rx="10" fill="#DFE8F3"/>
      <rect x="${barX}" y="${y - 1}" width="${fillWidth}" height="20" rx="10" fill="${task.color}"/>
      ${active ? `<circle cx="${barX + fillWidth}" cy="${y + 9}" r="5" fill="#FFFFFF" stroke="${task.color}" stroke-width="3"/>` : ''}
      ${done ? `<circle cx="${barX + barWidth - 10}" cy="${y + 9}" r="7" fill="#FFFFFF"/>${checkIcon(barX + barWidth - 10, y + 9, task.color, 0.72)}` : ''}
    `
  }).join('')

  const statusLabelX = clamp(statusX - 66, chartX, chartRight - 132)
  const change = finishChange(stateIndex)
  const changeColor = change.includes('推迟') ? '#D25868' : change.includes('提前') ? '#168F67' : '#74859B'
  const confetti = complete
    ? Array.from({ length: 16 }, (_, index) => {
        const x = 420 + (index * 61) % 600
        const y = 88 + (index % 3) * 18 + Math.sin(localFrame * 0.4 + index) * 4
        const color = ['#4F8EF7', '#16B884', '#F6B94A'][index % 3]
        return `<circle cx="${x}" cy="${y}" r="${2 + index % 3}" fill="${color}" opacity="0.78"/>`
      }).join('')
    : ''

  return `
  <svg width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <style>
        text { font-family: "PingFang SC", "Hiragino Sans GB", "Arial Unicode MS", sans-serif; }
        .title { font-size: 27px; font-weight: 700; fill: #18304F; letter-spacing: 0.3px; }
        .subtitle { font-size: 13px; fill: #71829A; }
        .axis { font-size: 11px; fill: #8292A8; }
        .snapshot-date { font-size: 11px; font-weight: 650; }
        .task-code { font-size: 10px; font-weight: 700; fill: #8796AA; }
        .task-name { font-size: 13px; font-weight: 600; fill: #263D5A; }
        .task-state { font-size: 10px; font-weight: 650; }
        .metric-label { font-size: 10px; fill: #8191A7; }
        .metric-value { font-size: 17px; font-weight: 700; fill: #253D5C; }
      </style>
      <filter id="softShadow" x="-20%" y="-20%" width="140%" height="140%">
        <feDropShadow dx="0" dy="3" stdDeviation="7" flood-color="#47698F" flood-opacity="0.14"/>
      </filter>
      <linearGradient id="progressGradient" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stop-color="#4F8EF7"/><stop offset="1" stop-color="#16B884"/>
      </linearGradient>
    </defs>

    <rect x="151" y="70" width="985" height="568" rx="26" fill="#FFFFFF" fill-opacity="0.94"/>
    <text x="170" y="111" class="title">CDN十二期中兴平面</text>
    <text x="170" y="136" class="subtitle">VPS 实际项目 · 5次状态快照 + 当前状态 · 43项现行任务</text>

    <rect x="930" y="88" width="185" height="48" rx="24" fill="${complete ? '#E9FAF3' : '#EEF4FF'}"/>
    <circle cx="957" cy="112" r="15" fill="${complete ? '#20B77A' : '#4F8EF7'}"/>
    ${complete ? checkIcon(957, 112) : `<path d="M957 102 A10 10 0 ${progressPercent > 50 ? 1 : 0} 1 948 117" fill="none" stroke="#FFFFFF" stroke-width="3" stroke-linecap="round"/>`}
    <text x="980" y="108" class="metric-label">项目进度</text>
    <text x="980" y="127" class="metric-value">${progressPercent}%</text>

    ${snapshotTrack}
    <rect x="170" y="198" width="946" height="34" rx="17" fill="#F1F5FA"/>
    <rect x="170" y="198" width="${946 * (stateIndex + 1) / states.length}" height="34" rx="17" fill="url(#progressGradient)"/>
    <text x="190" y="220" font-size="12" font-weight="700" fill="#FFFFFF">${state.note} · 状态版本 ${state.version}</text>
    ${complete ? `<text x="1096" y="220" text-anchor="end" font-size="12" font-weight="700" fill="#FFFFFF">全部任务完成 · 工程交付</text>` : ''}

    <text x="165" y="241" class="axis">关键任务（真实任务）</text>
    ${axisLabels}
    ${gridLines}
    ${taskRows}

    <line x1="${statusX}" y1="235" x2="${statusX}" y2="568" stroke="#E65C73" stroke-width="3"/>
    <circle cx="${statusX}" cy="235" r="6" fill="#FFFFFF" stroke="#E65C73" stroke-width="3"/>
    <rect x="${statusLabelX}" y="222" width="132" height="26" rx="13" fill="#E65C73" filter="url(#softShadow)"/>
    <text x="${statusLabelX + 66}" y="240" text-anchor="middle" font-size="11" font-weight="700" fill="#FFFFFF">状态日期 ${formatDate(state.date)}</text>

    <rect x="170" y="578" width="218" height="50" rx="14" fill="#F5F8FC"/>
    <text x="187" y="597" class="metric-label">完成任务</text>
    <text x="187" y="619" class="metric-value">${state.completed} / ${state.total}</text>

    <rect x="402" y="578" width="218" height="50" rx="14" fill="#F5F8FC"/>
    <text x="419" y="597" class="metric-label">状态日期</text>
    <text x="419" y="619" class="metric-value">${formatDate(state.date)}</text>

    <rect x="634" y="578" width="232" height="50" rx="14" fill="#F5F8FC"/>
    <text x="651" y="597" class="metric-label">计划完工</text>
    <text x="651" y="619" class="metric-value">${formatDate(state.plannedFinish)}</text>
    <text x="848" y="618" text-anchor="end" font-size="10" font-weight="650" fill="${changeColor}">${change}</text>

    <rect x="880" y="578" width="236" height="50" rx="14" fill="${complete ? '#ECFAF4' : '#F5F8FC'}"/>
    <text x="897" y="597" class="metric-label">项目状态</text>
    <text x="897" y="619" class="metric-value" fill="${complete ? '#159668' : '#253D5C'}">${complete ? '43项任务全部完成' : state.note}</text>
    ${confetti}
  </svg>`
}

async function main() {
  const background = await sharp(readFileSync(backgroundPath))
    .resize(WIDTH, HEIGHT, { fit: 'cover' })
    .png()
    .toBuffer()

  try {
    let frameIndex = 0
    for (let stateIndex = 0; stateIndex < states.length; stateIndex += 1) {
      const frameCount = FRAMES_PER_STATE + (stateIndex === states.length - 1 ? FINAL_HOLD_FRAMES : 0)
      for (let localFrame = 0; localFrame < frameCount; localFrame += 1) {
        const framePath = join(frameDir, `frame-${String(frameIndex).padStart(3, '0')}.png`)
        await sharp(background)
          .composite([{ input: Buffer.from(frameSvg(stateIndex, localFrame)) }])
          .png({ compressionLevel: 9 })
          .toFile(framePath)
        frameIndex += 1
      }
    }

    const palettePath = join(frameDir, 'palette.png')
    execFileSync('ffmpeg', [
      '-y', '-loglevel', 'error', '-framerate', String(FPS),
      '-i', join(frameDir, 'frame-%03d.png'),
      '-vf', 'palettegen=max_colors=176:stats_mode=diff', palettePath,
    ], { stdio: 'inherit' })
    execFileSync('ffmpeg', [
      '-y', '-loglevel', 'error', '-framerate', String(FPS),
      '-i', join(frameDir, 'frame-%03d.png'), '-i', palettePath,
      '-lavfi', 'paletteuse=dither=sierra2_4a:diff_mode=rectangle',
      '-loop', '0', outputPath,
    ], { stdio: 'inherit' })
  } finally {
    if (frameDir.startsWith(tmpdir())) rmSync(frameDir, { recursive: true, force: true })
  }

  console.log(outputPath)
}

await main()
