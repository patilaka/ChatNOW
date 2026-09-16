interface AvatarProps {
  name: string;
  size?: 'xs' | 'sm' | 'md' | 'lg';
  className?: string;
  emoji?: string;
  color?: string;
}

export function getInitials(name: string): string {
  const safe = (name || '?').trim();
  const parts = safe.split(/\s+/);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }
  const n = parts[0] || '';
  return n.slice(0, 2).toUpperCase();
}

function hashColor(name: string): string {
  const safe = name || '?';
  let hash = 0;
  for (let i = 0; i < safe.length; i++) {
    hash = safe.charCodeAt(i) + ((hash << 5) - hash);
  }
  const h = Math.abs(hash) % 360;
  return `hsl(${h}, 55%, 45%)`;
}

const sizeMap = {
  xs: 'w-5 h-5 text-[9px]',
  sm: 'w-6 h-6 text-[10px]',
  md: 'w-8 h-8 text-xs',
  lg: 'w-10 h-10 text-sm',
};

export default function Avatar({ name, size = 'md', className = '', emoji, color }: AvatarProps) {
  const safe = name || '?';
  return (
    <div
      className={`rounded-full flex items-center justify-center font-bold shrink-0 ${sizeMap[size]} ${className}`}
      style={{ backgroundColor: color || hashColor(safe) }}
      title={safe}
    >
      {emoji || getInitials(safe)}
    </div>
  );
}
