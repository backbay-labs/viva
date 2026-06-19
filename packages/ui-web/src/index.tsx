import type { ConceptStatus, StudyMode } from "@viva/core";
import type { CSSProperties, ReactNode } from "react";

type IconName =
  | "upload"
  | "mic"
  | "home"
  | "book"
  | "bars"
  | "bolt"
  | "cap"
  | "quiz"
  | "doc"
  | "arrow"
  | "chevron"
  | "down"
  | "check"
  | "clock"
  | "cal"
  | "share"
  | "plus"
  | "sliders"
  | "bulb"
  | "target"
  | "menu"
  | "x"
  | "refresh"
  | "flag"
  | "spark4"
  | "layers"
  | "pause"
  | "search"
  | "pen"
  | "graph"
  | "trash"
  | "archive";

const icons: Record<IconName, string[]> = {
  upload: ["M12 15V3", "M8 7l4-4 4 4", "M4 14v5a1 1 0 001 1h14a1 1 0 001-1v-5"],
  mic: ["M12 14a3 3 0 003-3V6a3 3 0 00-6 0v5a3 3 0 003 3z", "M6 11a6 6 0 0012 0", "M12 17v4"],
  home: ["M4 11l8-7 8 7", "M6 9.5V20h12V9.5"],
  book: ["M5 4h9a2 2 0 012 2v14H7a2 2 0 00-2 2V4z", "M16 7h3a1 1 0 011 1v12"],
  bars: ["M5 10v4", "M9 6v12", "M13 8v8", "M17 5v14", "M21 9v6"],
  bolt: ["M13 3L5 13h6l-1 8 8-11h-6l1-7z"],
  cap: ["M12 4L2 9l10 5 10-5-10-5z", "M6 11.5V16c0 1.4 3 2.8 6 2.8s6-1.4 6-2.8v-4.5"],
  quiz: [
    "M12 21a9 9 0 100-18 9 9 0 000 18z",
    "M9.6 9.2A2.5 2.5 0 0114 10.6c0 1.7-2 2-2 3.6",
    "M12 17.4h.01",
  ],
  doc: ["M7 3h7l4 4v14H7V3z", "M14 3v4h4"],
  arrow: ["M5 12h14", "M13 6l6 6-6 6"],
  chevron: ["M9 6l6 6-6 6"],
  down: ["M6 9l6 6 6-6"],
  check: ["M5 12.5l4.5 4.5L19 7"],
  clock: ["M12 21a9 9 0 100-18 9 9 0 000 18z", "M12 7.5V12l3.2 1.9"],
  cal: ["M5 6h14v14H5V6z", "M5 10h14", "M9 3v4", "M15 3v4"],
  share: ["M4 12v7a1 1 0 001 1h14a1 1 0 001-1v-7", "M12 16V3", "M8 7l4-4 4 4"],
  plus: ["M12 5v14", "M5 12h14"],
  sliders: ["M4 8h9", "M17 8h3", "M16 6v4", "M4 16h3", "M11 16h9", "M8 14v4"],
  bulb: [
    "M9.5 18h5",
    "M10 21h4",
    "M12 3a6 6 0 00-3.8 10.6c.7.6 1.1 1.2 1.2 2.4h5.2c.1-1.2.5-1.8 1.2-2.4A6 6 0 0012 3z",
  ],
  target: ["M12 21a9 9 0 100-18 9 9 0 000 18z", "M12 16a4 4 0 100-8 4 4 0 000 8z", "M12 12h.01"],
  menu: ["M4 7h16", "M4 12h16", "M4 17h16"],
  x: ["M6 6l12 12", "M18 6L6 18"],
  refresh: ["M20 11a8 8 0 00-14-5L4 8", "M4 13a8 8 0 0014 5l2-2", "M4 4v4h4", "M20 20v-4h-4"],
  flag: ["M6 21V4", "M6 4h11l-2 4 2 4H6"],
  spark4: [
    "M12 4c.4 4 2.5 6.1 6.5 6.5-4 .4-6.1 2.5-6.5 6.5-.4-4-2.5-6.1-6.5-6.5C9.5 10.1 11.6 8 12 4z",
  ],
  layers: ["M12 4l8 4-8 4-8-4 8-4z", "M4 12l8 4 8-4", "M4 16l8 4 8-4"],
  pause: ["M9 5v14", "M15 5v14"],
  search: ["M11 18a7 7 0 100-14 7 7 0 000 14z", "M20 20l-4-4"],
  pen: ["M4 20h4L19 9l-4-4L4 16v4z", "M14 6l4 4"],
  graph: ["M5 19V5", "M5 19h14", "M9 15l3-4 3 2 4-6"],
  trash: ["M4 7h16", "M10 11v6", "M14 11v6", "M6 7l1 14h10l1-14", "M9 7V4h6v3"],
  archive: ["M4 7h16v4H4V7z", "M6 11v9h12v-9", "M10 15h4"],
};

export function Icon({
  name,
  size = 18,
  strokeWidth = 1.6,
  color = "currentColor",
  fill = false,
  className,
}: {
  name: IconName;
  size?: number;
  strokeWidth?: number;
  color?: string;
  fill?: boolean;
  className?: string;
}) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      fill="none"
      height={size}
      stroke={fill ? "none" : color}
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={strokeWidth}
      viewBox="0 0 24 24"
      width={size}
    >
      {icons[name].map((path) => (
        <path d={path} fill={fill ? color : "none"} key={path} />
      ))}
    </svg>
  );
}

export function Spark({
  size = 16,
  color = "currentColor",
  className,
  style,
}: {
  size?: number;
  color?: string;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      fill={color}
      height={size}
      style={style}
      viewBox="0 0 24 24"
      width={size}
    >
      <path d="M12 4c.4 4 2.5 6.1 6.5 6.5-4 .4-6.1 2.5-6.5 6.5-.4-4-2.5-6.1-6.5-6.5C9.5 10.1 11.6 8 12 4z" />
    </svg>
  );
}

export function VoiceOrb({
  size = 200,
  state = "ready",
  className = "",
}: {
  size?: number;
  state?: "ready" | "listening" | "thinking" | "correcting" | "encouraging" | "recall" | "complete";
  className?: string;
}) {
  return (
    <div
      className={`orb ${className}`}
      data-state={state}
      style={{ "--orb": `${size}px` } as CSSProperties}
    >
      <div className="orb__glow" />
      <div className="orb__halo two" />
      <div className="orb__halo" />
      <div className="orb__pulse" />
      <div className="orb__pulse b" />
      <div className="orb__shimmer" />
      <div className="orb__core">
        <Spark className="orb__star" color="#fff" size={size * 0.17} />
      </div>
      <div className="orb__orbiter" />
    </div>
  );
}

export function Equalizer({
  bars = 10,
  wide = false,
  faint = false,
}: {
  bars?: number;
  wide?: boolean;
  faint?: boolean;
}) {
  const barKeys = Array.from({ length: bars }, (_, index) => `bar-${index + 1}`);

  return (
    <div className={`eq${wide ? " wide" : ""}${faint ? " faint" : ""}`} aria-hidden="true">
      {barKeys.map((key) => (
        <i key={key} />
      ))}
    </div>
  );
}

export function Wordmark({ size = 34, tagline = false }: { size?: number; tagline?: boolean }) {
  return (
    <div className="wordmark" style={{ "--wordmark-size": `${size}px` } as CSSProperties}>
      <span className="serif wordmark__text">Viva</span>
      <Spark className="wordmark__spark" color="var(--plum)" size={size * 0.34} />
      {tagline ? (
        <span className="kicker wordmark__tagline">Voice-first AI study companion</span>
      ) : null}
    </div>
  );
}

export function ContextPill({ items, small = false }: { items: string[]; small?: boolean }) {
  return (
    <span className={`chip context-pill${small ? " context-pill--small" : ""}`}>
      <Icon color="var(--plum)" name="layers" size={small ? 13 : 15} />
      {items.map((item, index) => (
        <span
          className={index === 0 ? "context-pill__primary" : "context-pill__secondary"}
          key={item}
        >
          {index > 0 ? <span className="context-pill__dot">·</span> : null}
          {item}
        </span>
      ))}
    </span>
  );
}

const modeIcon: Record<StudyMode, IconName> = {
  quiz: "quiz",
  teach: "cap",
  mock: "mic",
  cram: "bolt",
};

export function ModeChip({
  mode,
  label,
  active = false,
  onClick,
}: {
  mode: StudyMode;
  label: string;
  active?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      className={`chip mode-chip${active ? " mode-chip--active" : ""}`}
      onClick={onClick}
      type="button"
    >
      <Icon
        color={active ? "var(--plum-soft)" : "var(--plum)"}
        fill={mode === "cram"}
        name={modeIcon[mode]}
        size={16}
      />
      {label}
    </button>
  );
}

export function SourceChip({ label, tone = "plum" }: { label: string; tone?: "plum" | "neutral" }) {
  return (
    <span className={`chip source-chip source-chip--${tone}`}>
      <Icon name="doc" size={13} />
      {label}
    </span>
  );
}

const tierLabels: Record<ConceptStatus, string> = {
  strong: "Strong",
  shaky: "Shaky",
  missed: "Missed",
  review: "Review",
};

export function MasteryChip({
  tier,
  label,
  pct,
}: {
  tier: ConceptStatus;
  label?: string;
  pct?: number;
}) {
  return (
    <span className={`chip mastery-chip mastery-chip--${tier}`}>
      <span className="mastery-chip__dot" />
      {label ?? tierLabels[tier]}
      {pct == null ? null : <span className="mastery-chip__pct">· {pct}%</span>}
    </span>
  );
}

export function MasteryRing({
  pct,
  size = 88,
  stroke = 8,
  color = "var(--sage)",
  label,
}: {
  pct: number;
  size?: number;
  stroke?: number;
  color?: string;
  label?: string;
}) {
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - pct / 100);
  return (
    <div className="mastery-ring" style={{ height: size, width: size }}>
      <svg aria-hidden="true" height={size} style={{ transform: "rotate(-90deg)" }} width={size}>
        <circle
          cx={size / 2}
          cy={size / 2}
          fill="none"
          r={radius}
          stroke="rgba(44,37,54,.08)"
          strokeWidth={stroke}
        />
        <circle
          className="mastery-ring__progress"
          cx={size / 2}
          cy={size / 2}
          fill="none"
          r={radius}
          stroke={color}
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          strokeLinecap="round"
          strokeWidth={stroke}
          style={
            {
              "--ring-circ": circumference,
              "--ring-offset": offset,
            } as CSSProperties
          }
        />
      </svg>
      <span className="mastery-ring__label">
        <span className="serif">{pct}</span>%{label ? <small>{label}</small> : null}
      </span>
    </div>
  );
}

export function ActionCard({
  icon,
  kicker,
  title,
  body,
  accent = "plum",
  primary = false,
  onClick,
}: {
  icon: IconName;
  kicker: string;
  title: string;
  body: string;
  accent?: "plum" | "sage" | "gold" | "amber";
  primary?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      className={`action-card action-card--${accent}${primary ? " action-card--primary" : ""}`}
      onClick={onClick}
      type="button"
    >
      <span className="action-card__top">
        <span className="action-card__icon">
          <Icon name={icon} size={17} />
        </span>
        <span className="kicker">{kicker}</span>
      </span>
      <span className="serif action-card__title">{title}</span>
      <span className="action-card__body">{body}</span>
      <span className="action-card__arrow">
        <Icon name="arrow" size={15} />
      </span>
    </button>
  );
}

export function FeedbackCard({
  icon,
  title,
  body,
  accent = "plum",
  onClick,
}: {
  icon: IconName;
  title: string;
  body: string;
  accent?: "plum" | "sage" | "gold" | "amber";
  onClick?: () => void;
}) {
  return (
    <button className={`feedback-card feedback-card--${accent}`} onClick={onClick} type="button">
      <span className="feedback-card__icon">
        <Icon name={icon} size={16} />
      </span>
      <span>
        <strong>{title}</strong>
        <small>{body}</small>
      </span>
      <Icon className="feedback-card__chevron" name="chevron" size={15} />
    </button>
  );
}

export function TranscriptLine({
  who,
  text,
  time,
}: {
  who: "viva" | "you";
  text: string;
  time: string;
}) {
  const isViva = who === "viva";
  return (
    <div className="transcript-line">
      <span className={`transcript-line__avatar${isViva ? " transcript-line__avatar--viva" : ""}`}>
        {isViva ? (
          <Spark color="var(--plum)" size={12} />
        ) : (
          <Icon color="var(--ink-3)" name="mic" size={12} />
        )}
      </span>
      <span>
        <span className="transcript-line__meta">
          <strong>{isViva ? "Viva" : "You"}</strong>
          <time>{time}</time>
        </span>
        <span className="transcript-line__text">{text}</span>
      </span>
    </div>
  );
}

export function TimelineItem({
  status,
  day,
  topics,
  meta,
  last = false,
}: {
  status: "done" | "today" | "upcoming";
  day: string;
  topics: string;
  meta: string;
  last?: boolean;
}) {
  return (
    <div className={`timeline-item timeline-item--${status}`}>
      <span className="timeline-item__rail">
        <span className="timeline-item__dot">
          {status === "done" ? (
            <Icon color="#fff" name="check" size={13} strokeWidth={2.2} />
          ) : null}
        </span>
        {last ? null : <span className="timeline-item__line" />}
      </span>
      <span className="timeline-item__content">
        <span>
          <strong>{day}</strong>
          <small>{topics}</small>
        </span>
        <em>{meta}</em>
      </span>
    </div>
  );
}

export function Avatar({ initial = "A" }: { initial?: string }) {
  return <span className="avatar">{initial}</span>;
}

export function NavRail({
  active,
  onNavigate,
  footer,
}: {
  active: "Today" | "Library" | "Sessions";
  onNavigate: (view: "home" | "library" | "session") => void;
  footer?: ReactNode;
}) {
  const items: Array<{
    label: "Today" | "Library" | "Sessions";
    icon: IconName;
    view: "home" | "library" | "session";
  }> = [
    { label: "Today", icon: "home", view: "home" },
    { label: "Library", icon: "book", view: "library" },
    { label: "Sessions", icon: "bars", view: "session" },
  ];

  return (
    <aside className="nav-rail">
      <Wordmark size={28} />
      <nav aria-label="Primary">
        {items.map((item) => (
          <button
            className={`nav-rail__item${item.label === active ? " nav-rail__item--active" : ""}`}
            key={item.label}
            onClick={() => onNavigate(item.view)}
            type="button"
          >
            <Icon name={item.icon} size={18} />
            {item.label}
          </button>
        ))}
      </nav>
      <div className="nav-rail__spacer" />
      {footer}
      <div className="nav-rail__profile">
        <Avatar />
        <span>
          <strong>Ananya</strong>
          <small>Local prototype</small>
        </span>
        <Icon color="var(--ink-3)" name="sliders" size={17} />
      </div>
    </aside>
  );
}

export function ProgressBar({ value, label }: { value: number; label?: string }) {
  return (
    <span className="progress-bar">
      <span className="progress-bar__track">
        <span
          className="progress-bar__fill"
          style={{ width: `${Math.max(0, Math.min(value, 100))}%` }}
        />
      </span>
      {label ? <small>{label}</small> : null}
    </span>
  );
}

export function MobileTabs({
  active,
  onNavigate,
}: {
  active: "Today" | "Library" | "Sessions";
  onNavigate: (view: "home" | "library" | "session") => void;
}) {
  const tabs: Array<{
    label: "Today" | "Library" | "Sessions";
    icon: IconName;
    view: "home" | "library" | "session";
  }> = [
    { label: "Today", icon: "home", view: "home" },
    { label: "Library", icon: "book", view: "library" },
    { label: "Sessions", icon: "bars", view: "session" },
  ];

  return (
    <nav aria-label="Mobile primary" className="mobile-tabs">
      {tabs.map((tab) => (
        <button
          className={tab.label === active ? "is-active" : ""}
          key={tab.label}
          onClick={() => onNavigate(tab.view)}
          type="button"
        >
          <Icon name={tab.icon} size={20} />
          <span>{tab.label}</span>
        </button>
      ))}
    </nav>
  );
}
