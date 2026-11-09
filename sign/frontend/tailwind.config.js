import tailwindcssAnimate from 'tailwindcss-animate'

/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ['class'],
  content: ['./index.html', './src/**/*.{vue,js,ts,jsx,tsx}'],
  theme: {
    // Legacy color utilities for existing UI — keep as-is
    extend: {
      colors: {
        // Legacy palette (existing pages depend on these)
        primary: '#3b82f6',
        secondary: '#64748b',
        // 0731:原 #10b981 是绿。0728「绿色整套删掉」清的是 style.css 和 .vue 里的**色值**,
        // 扫不到调色板配置 —— 而这里改一个字,text-success 就能把绿放回全站。
        // 全站 0 处引用(content 只扫 index.html + src/**,已全量 grep 过),
        // 故与 style.css 的 --success 取同一个灰,而不是留个绿在这等人踩。
        success: '#475569',
        warning: '#f59e0b',
        danger: '#ef4444',

        // shadcn-vue design system (v2 pages) — CSS-variable based
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        card: {
          DEFAULT: 'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))',
        },
        popover: {
          DEFAULT: 'hsl(var(--popover))',
          foreground: 'hsl(var(--popover-foreground))',
        },
        muted: {
          DEFAULT: 'hsl(var(--sh-muted))',
          foreground: 'hsl(var(--sh-muted-foreground))',
        },
        accent: {
          DEFAULT: 'hsl(var(--sh-accent))',
          foreground: 'hsl(var(--sh-accent-foreground))',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))',
        },
        sidebar: {
          DEFAULT: 'hsl(var(--sidebar-background))',
          foreground: 'hsl(var(--sidebar-foreground))',
          primary: 'hsl(var(--sidebar-primary))',
          'primary-foreground': 'hsl(var(--sidebar-primary-foreground))',
          accent: 'hsl(var(--sidebar-accent))',
          'accent-foreground': 'hsl(var(--sidebar-accent-foreground))',
          border: 'hsl(var(--sidebar-border))',
          ring: 'hsl(var(--sidebar-ring))',
        },
        // Status colors (shared between old + new UI via CSS var, mapped here)
        status: {
          ok: 'hsl(var(--status-ok))',
          warn: 'hsl(var(--status-warn))',
          error: 'hsl(var(--status-error))',
          info: 'hsl(var(--status-info))',
          test: 'hsl(var(--status-test))',
        },
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
      },
      fontFamily: {
        sans: ['Noto Sans SC', 'Segoe UI', 'Microsoft YaHei', 'sans-serif'],
      },
      keyframes: {
        'accordion-down': {
          from: { height: '0' },
          to: { height: 'var(--radix-accordion-content-height)' },
        },
        'accordion-up': {
          from: { height: 'var(--radix-accordion-content-height)' },
          to: { height: '0' },
        },
        'collapsible-down': {
          from: { height: '0' },
          to: { height: 'var(--radix-collapsible-content-height)' },
        },
        'collapsible-up': {
          from: { height: 'var(--radix-collapsible-content-height)' },
          to: { height: '0' },
        },
      },
      animation: {
        'accordion-down': 'accordion-down 0.2s ease-out',
        'accordion-up': 'accordion-up 0.2s ease-out',
        'collapsible-down': 'collapsible-down 0.2s ease-out',
        'collapsible-up': 'collapsible-up 0.2s ease-out',
      },
    },
  },
  plugins: [tailwindcssAnimate],
}
