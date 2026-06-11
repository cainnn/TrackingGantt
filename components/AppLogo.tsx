type AppLogoProps = {
  size?: 'sm' | 'md'
  showText?: boolean
}

const sizeClasses = {
  sm: {
    image: 'h-8 w-8',
    title: 'text-xl',
    subtitle: 'text-xs',
  },
  md: {
    image: 'h-12 w-12',
    title: 'text-2xl',
    subtitle: 'text-sm',
  },
}

export default function AppLogo({ size = 'sm', showText = true }: AppLogoProps) {
  const classes = sizeClasses[size]

  return (
    <div className="flex items-center gap-3">
      <img src="/brand-icon.svg" alt="跟踪甘特图" className={`${classes.image} flex-none`} />
      {showText && (
        <div className="min-w-0">
          <div className={`${classes.title} font-bold leading-tight text-gray-900`}>跟踪甘特图</div>
          <div className={`${classes.subtitle} leading-tight text-gray-500`}>项目进度管理工具</div>
        </div>
      )}
    </div>
  )
}
