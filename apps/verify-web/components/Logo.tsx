/**
 * 品牌主 logo（与主站 apps/web/components/Logo.tsx 同一几何：C 弧 + 穿过缺口的突破趋势线；UV-02）。
 * 颜色缺省 currentColor，父级给 text-brand-* 即可；纯内联 SVG，CSP 友好。
 */
export function LogoMark({ size = 24, color = "currentColor", className }: { size?: number; color?: string; className?: string }) {
  const cx = size / 2;
  const cy = size / 2;
  const r = size * 0.355;
  const sw = size * 0.068;
  const rad = (d: number) => (d * Math.PI) / 180;
  const gapDeg = 42;
  const ax1 = cx + r * Math.cos(rad(gapDeg));
  const ay1 = cy + r * Math.sin(rad(gapDeg));
  const ax2 = cx + r * Math.cos(rad(-gapDeg));
  const ay2 = cy + r * Math.sin(rad(-gapDeg));
  const pts = [
    [cx - r * 0.52, cy + r * 0.2],
    [cx + r * 0.07, cy - r * 0.22],
    [cx + r * 0.92, cy - r * 0.04],
  ];
  const pointsStr = pts.map((p) => p.map((v) => v.toFixed(2)).join(",")).join(" ");
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} fill="none" xmlns="http://www.w3.org/2000/svg" className={className} aria-hidden>
      <path d={`M ${ax1.toFixed(2)} ${ay1.toFixed(2)} A ${r.toFixed(2)} ${r.toFixed(2)} 0 1 0 ${ax2.toFixed(2)} ${ay2.toFixed(2)}`} stroke={color} strokeWidth={sw} strokeLinecap="round" fill="none" />
      <polyline points={pointsStr} stroke={color} strokeWidth={sw * 0.62} strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </svg>
  );
}

/** 字标：CHACONNE（宽字距）+ 小号 Agent（站名；产品能力仍叫「核验 / Verify」） */
export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={`inline-flex items-baseline gap-1.5 ${className ?? ""}`}>
      {/* 窄屏隐藏长字标，只留标志 + Agent：头部左上角加了「Markets」入口后，390px 下原来会横向溢出 30px */}
      <span className="verify-wordmark-long text-[13px] font-bold tracking-[0.14em] text-fg-1">CHACONNE</span>
      <span className="text-[11px] font-semibold text-brand-300">Agent</span>
    </span>
  );
}
