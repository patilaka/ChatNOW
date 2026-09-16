import { useRef, type KeyboardEvent } from 'react';

interface OtpInputProps {
  value: string;
  onChange: (value: string) => void;
}

export default function OtpInput({ value, onChange }: OtpInputProps) {
  const refs = useRef<(HTMLInputElement | null)[]>([]);

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>, i: number) => {
    if (e.key === 'Backspace' && !value[i] && i > 0) {
      refs.current[i - 1]?.focus();
    }
  };

  const handleInput = (char: string, i: number) => {
    if (!/^\d$/.test(char)) return;
    const digits = value.split('');
    digits[i] = char;
    const newVal = digits.join('');
    onChange(newVal);
    if (i < 3) refs.current[i + 1]?.focus();
  };

  return (
    <div className="flex gap-3 justify-center">
      {[0, 1, 2, 3].map((i) => (
        <input
          key={i}
          ref={(el) => { refs.current[i] = el; }}
          type="text"
          inputMode="numeric"
          maxLength={1}
          value={value[i] || ''}
          onChange={(e) => handleInput(e.target.value, i)}
          onKeyDown={(e) => handleKeyDown(e, i)}
          className="w-12 h-12 text-center text-xl font-bold bg-[#0D0D0D] border-2 border-[#333] rounded-lg text-white outline-none focus:border-[#007AFF] transition-colors"
        />
      ))}
    </div>
  );
}
