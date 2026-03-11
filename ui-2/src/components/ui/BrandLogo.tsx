import logoImage from '../../../assets/logo.png';
import { useTheme } from '../../context/ThemeContext';

interface BrandLogoProps {
  alt: string;
  className?: string;
}

export default function BrandLogo({ alt, className = '' }: BrandLogoProps) {
  const { theme } = useTheme();

  return (
    <img
      src={logoImage}
      alt={alt}
      className={`${className} ${theme === 'dark' ? 'brightness-0 invert' : ''}`.trim()}
    />
  );
}
