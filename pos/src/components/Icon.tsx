/**
 * The icon set.
 *
 * Emoji were doing this job. They render differently on every OS, they carry
 * a colour you did not choose, and they read as a prototype — which is fatal
 * for software a shop is asked to run its money through.
 *
 * These are one family: 24px box, 1.75 stroke, round caps and joins, drawn on
 * the same grid so they optically match at 20px in a tab bar and at 40px in an
 * empty state. `currentColor` throughout, so a parent's text colour is the
 * only thing that decides how they look.
 */

export type IconName =
  | 'receipt'
  | 'box'
  | 'inbox'
  | 'globe'
  | 'chart'
  | 'trending'
  | 'settings'
  | 'search'
  | 'user'
  | 'clock'
  | 'plus'
  | 'minus'
  | 'close'
  | 'check'
  | 'cash'
  | 'card'
  | 'qr'
  | 'printer'
  | 'share'
  | 'camera'
  | 'chevronRight'
  | 'alert'
  | 'cloudOff';

interface IconProps {
  name: IconName;
  size?: number;
  className?: string;
  strokeWidth?: number;
}

const PATHS: Record<IconName, React.ReactNode> = {
  receipt: (
    <>
      <path d="M5 3.5h14v17l-2.5-1.6-2.5 1.6-2.5-1.6L9 20.5 6.5 18.9 5 20.5z" />
      <path d="M9 8.5h6M9 12.5h6" />
    </>
  ),
  box: (
    <>
      <path d="M3.5 7.8 12 3.5l8.5 4.3v8.4L12 20.5l-8.5-4.3z" />
      <path d="m3.5 7.8 8.5 4.4 8.5-4.4M12 12.2v8.3" />
    </>
  ),
  inbox: (
    <>
      <path d="M3.5 13.5h4l1.5 3h6l1.5-3h4" />
      <path d="M5.6 4.5h12.8l2.1 9v5a2 2 0 0 1-2 2H5.5a2 2 0 0 1-2-2v-5z" />
    </>
  ),
  globe: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M3.5 12h17M12 3.5c2.2 2.3 3.4 5.3 3.4 8.5S14.2 18.2 12 20.5c-2.2-2.3-3.4-5.3-3.4-8.5S9.8 5.8 12 3.5z" />
    </>
  ),
  chart: (
    <>
      <path d="M4 20.2h16" />
      <path d="M7 20V11M12 20V5M17 20v-6" />
    </>
  ),
  trending: (
    <>
      <path d="M3.5 16.5 9 11l3.5 3.5 8-8" />
      <path d="M15.5 6.5h5v5" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.6 1.6 0 0 0 .32 1.77l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.6 1.6 0 0 0-1.77-.32 1.6 1.6 0 0 0-1 1.46V21a2 2 0 1 1-4 0v-.11a1.6 1.6 0 0 0-1.05-1.46 1.6 1.6 0 0 0-1.77.32l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.6 1.6 0 0 0 4.6 15a1.6 1.6 0 0 0-1.46-1H3a2 2 0 1 1 0-4h.11A1.6 1.6 0 0 0 4.6 8.9a1.6 1.6 0 0 0-.32-1.77l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.6 1.6 0 0 0 1.77.32H9a1.6 1.6 0 0 0 1-1.46V3a2 2 0 1 1 4 0v.11a1.6 1.6 0 0 0 1 1.46 1.6 1.6 0 0 0 1.77-.32l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.6 1.6 0 0 0-.32 1.77V9a1.6 1.6 0 0 0 1.46 1H21a2 2 0 1 1 0 4h-.11a1.6 1.6 0 0 0-1.46 1z" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m16 16 4.5 4.5" />
    </>
  ),
  user: (
    <>
      <circle cx="12" cy="8" r="3.75" />
      <path d="M4.5 20.5a7.5 7.5 0 0 1 15 0" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7v5.2l3.2 2" />
    </>
  ),
  plus: <path d="M12 5.5v13M5.5 12h13" />,
  minus: <path d="M5.5 12h13" />,
  close: <path d="m6.5 6.5 11 11M17.5 6.5l-11 11" />,
  check: <path d="m5 12.5 4.5 4.5L19 7.5" />,
  cash: (
    <>
      <rect x="2.5" y="6" width="19" height="12" rx="2.5" />
      <circle cx="12" cy="12" r="2.5" />
      <path d="M6 10v4M18 10v4" />
    </>
  ),
  card: (
    <>
      <rect x="2.5" y="5" width="19" height="14" rx="2.5" />
      <path d="M2.5 10h19M6.5 15h3" />
    </>
  ),
  qr: (
    <>
      <rect x="3.5" y="3.5" width="7" height="7" rx="1.5" />
      <rect x="13.5" y="3.5" width="7" height="7" rx="1.5" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="1.5" />
      <path d="M13.5 13.5h3v3h-3zM20.5 13.5v3M17.5 20.5h3M13.5 20.5h.01" />
    </>
  ),
  printer: (
    <>
      <path d="M6.5 9V3.5h11V9" />
      <path d="M6.5 17.5h-2a2 2 0 0 1-2-2V11a2 2 0 0 1 2-2h15a2 2 0 0 1 2 2v4.5a2 2 0 0 1-2 2h-2" />
      <path d="M6.5 14h11v6.5h-11z" />
    </>
  ),
  share: (
    <>
      <path d="M12 15.5V3.5M8.5 7 12 3.5 15.5 7" />
      <path d="M4.5 13.5v5a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-5" />
    </>
  ),
  camera: (
    <>
      <path d="M3.5 8.5h3l1.5-2.5h8l1.5 2.5h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-18a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1z" />
      <circle cx="12" cy="13.5" r="3.5" />
    </>
  ),
  chevronRight: <path d="m9.5 5.5 6.5 6.5-6.5 6.5" />,
  alert: (
    <>
      <path d="M12 3.5 21.5 20h-19z" />
      <path d="M12 9.5v4.5M12 17.2h.01" />
    </>
  ),
  cloudOff: (
    <>
      <path d="M17.5 17.5H7a4.5 4.5 0 0 1-.9-8.9" />
      <path d="M9 6.2A5.5 5.5 0 0 1 18.4 10a4 4 0 0 1 2.3 6.7" />
      <path d="m3.5 3.5 17 17" />
    </>
  ),
};

export function Icon({ name, size = 20, className = '', strokeWidth = 1.75 }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
}
