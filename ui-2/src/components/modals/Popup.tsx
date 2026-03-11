import { X } from 'lucide-react';
import { useEffect, useState } from 'react';
interface PopupProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  maxWidth?: string;
}

export default function Popup({
  isOpen,
  onClose,
  title,
  children,
  maxWidth = 'max-w-4xl',
}: PopupProps) {
  const [isAnimating, setIsAnimating] = useState(false);
  useEffect(() => {
    if (isOpen) {
      setIsAnimating(true);
    }
  }, [isOpen]);

  const handleClose = () => {
    setIsAnimating(false);
    setTimeout(() => {
      onClose();
    }, 200);
  };

  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        handleClose();
      }
    };

    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [isOpen]);

  if (!isOpen) return null;

  return (
    <div
      className={`fixed inset-0 z-50 flex items-center justify-center p-4 transition-all duration-300 ${
        isAnimating ? 'opacity-100' : 'opacity-0'
      }`}
      onClick={handleClose}
    >
      <div
        className={`absolute inset-0 bg-black/60 backdrop-blur-sm transition-all duration-300 ${
          isAnimating ? 'opacity-100' : 'opacity-0'
        }`}
      />

      <div
        className={`relative w-full ${maxWidth} h-[85vh] mac-glass mac-glass-translucent mac-border-highlight flex flex-col overflow-hidden transition-all duration-300 ${
          isAnimating
            ? 'scale-100 translate-y-0 opacity-100'
            : 'scale-90 translate-y-8 opacity-0'
        }`}
        style={{
          animation: isAnimating ? 'popupBounce 0.4s cubic-bezier(0.68, -0.55, 0.265, 1.55)' : 'none',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-white/10 bg-black/20">
          <h2 className="text-2xl font-semibold text-white">{title}</h2>
          <button
            onClick={handleClose}
            className="p-2 hover:bg-white/10 rounded-lg transition-colors group"
          >
            <X className="w-6 h-6 text-slate-300 group-hover:text-white transition-colors" />
          </button>
        </div>

        <div className="flex-1 overflow-hidden">{children}</div>
      </div>

      <style>{`
        @keyframes popupBounce {
          0% {
            transform: scale(0.8) translateY(50px);
            opacity: 0;
          }
          50% {
            transform: scale(1.02) translateY(-5px);
          }
          100% {
            transform: scale(1) translateY(0);
            opacity: 1;
          }
        }
      `}</style>
    </div>
  );
}
