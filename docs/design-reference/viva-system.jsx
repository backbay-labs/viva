// viva-system.jsx — Viva design system: icons, voice orb, core components.
// Exports everything to window for the screen files + main composer.
const { useState, useEffect, useRef } = React;

/* ───────────────────────── Icons ───────────────────────── */
const ICONS = {
  upload:['M12 15V3','M8 7l4-4 4 4','M4 14v5a1 1 0 001 1h14a1 1 0 001-1v-5'],
  mic:['M12 14a3 3 0 003-3V6a3 3 0 00-6 0v5a3 3 0 003 3z','M6 11a6 6 0 0012 0','M12 17v4'],
  home:['M4 11l8-7 8 7','M6 9.5V20h12V9.5'],
  book:['M5 4h9a2 2 0 012 2v14H7a2 2 0 00-2 2V4z','M16 7h3a1 1 0 011 1v12'],
  bars:['M5 10v4','M9 6v12','M13 8v8','M17 5v14','M21 9v6'],
  bolt:['M13 3L5 13h6l-1 8 8-11h-6l1-7z'],
  cap:['M12 4L2 9l10 5 10-5-10-5z','M6 11.5V16c0 1.4 3 2.8 6 2.8s6-1.4 6-2.8v-4.5'],
  quiz:['M12 21a9 9 0 100-18 9 9 0 000 18z','M9.6 9.2A2.5 2.5 0 0114 10.6c0 1.7-2 2-2 3.6','M12 17.4h.01'],
  doc:['M7 3h7l4 4v14H7V3z','M14 3v4h4'],
  arrow:['M5 12h14','M13 6l6 6-6 6'],
  chevron:['M9 6l6 6-6 6'],
  down:['M6 9l6 6 6-6'],
  check:['M5 12.5l4.5 4.5L19 7'],
  clock:['M12 21a9 9 0 100-18 9 9 0 000 18z','M12 7.5V12l3.2 1.9'],
  cal:['M5 6h14v14H5V6z','M5 10h14','M9 3v4','M15 3v4'],
  share:['M4 12v7a1 1 0 001 1h14a1 1 0 001-1v-7','M12 16V3','M8 7l4-4 4 4'],
  plus:['M12 5v14','M5 12h14'],
  sliders:['M4 8h9','M17 8h3','M16 6v4','M4 16h3','M11 16h9','M8 14v4'],
  bulb:['M9.5 18h5','M10 21h4','M12 3a6 6 0 00-3.8 10.6c.7.6 1.1 1.2 1.2 2.4h5.2c.1-1.2.5-1.8 1.2-2.4A6 6 0 0012 3z'],
  target:['M12 21a9 9 0 100-18 9 9 0 000 18z','M12 16a4 4 0 100-8 4 4 0 000 8z','M12 12h.01'],
  menu:['M4 7h16','M4 12h16','M4 17h16'],
  x:['M6 6l12 12','M18 6L6 18'],
  refresh:['M20 11a8 8 0 00-14-5L4 8','M4 13a8 8 0 0014 5l2-2','M4 4v4h4','M20 20v-4h-4'],
  flag:['M6 21V4','M6 4h11l-2 4 2 4H6'],
  spark4:['M12 4c.4 4 2.5 6.1 6.5 6.5-4 .4-6.1 2.5-6.5 6.5-.4-4-2.5-6.1-6.5-6.5C9.5 10.1 11.6 8 12 4z'],
  layers:['M12 4l8 4-8 4-8-4 8-4z','M4 12l8 4 8-4','M4 16l8 4 8-4'],
  pause:['M9 5v14','M15 5v14'],
  search:['M11 18a7 7 0 100-14 7 7 0 000 14z','M20 20l-4-4'],
  pen:['M4 20h4L19 9l-4-4L4 16v4z','M14 6l4 4'],
  graph:['M5 19V5','M5 19h14','M9 15l3-4 3 2 4-6'],
};
function Icon({name, size=18, sw=1.6, color='currentColor', style, fill}) {
  const d = ICONS[name] || [];
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke={fill?'none':color} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"
      style={{display:'block',flex:'none',...style}}>
      {d.map((p,i)=><path key={i} d={p} fill={fill?color:'none'} />)}
    </svg>
  );
}
// filled 4-point sparkle
function Spark({size=16, color='currentColor', style}) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={color} style={{display:'block',...style}}>
      <path d="M12 4c.4 4 2.5 6.1 6.5 6.5-4 .4-6.1 2.5-6.5 6.5-.4-4-2.5-6.1-6.5-6.5C9.5 10.1 11.6 8 12 4z"/>
    </svg>
  );
}
// botanical sprig (decorative, from concept)
function Sprig({w=120, color='var(--gold)', style}) {
  return (
    <svg width={w} height={w*0.62} viewBox="0 0 120 74" fill="none" stroke={color} strokeWidth="1" className="sprig" style={style}>
      <path d="M60 72C60 50 50 30 24 18" strokeLinecap="round"/>
      {[0,1,2,3,4].map(i=>{const t=i/5;const x=60-36*t;const y=72-54*t;return(
        <g key={i}>
          <path d={`M${x} ${y}q-11 -3 -16 -12q10 -1 16 6`} strokeLinecap="round"/>
          <path d={`M${x} ${y}q11 -4 17 -13q-10 0 -17 7`} strokeLinecap="round"/>
        </g>);})}
      <circle cx="24" cy="18" r="3.4" fill={color} stroke="none"/>
    </svg>
  );
}

/* ───────────────────────── Voice Orb ───────────────────────── */
function VoiceOrb({size=200, state='ready', star=true, className='', style}) {
  return (
    <div className={'orb '+className} data-state={state} style={{'--orb':size+'px',...style}}>
      <div className="orb__glow"/>
      <div className="orb__halo two"/>
      <div className="orb__halo"/>
      <div className="orb__pulse"/>
      <div className="orb__pulse b"/>
      <div className="orb__shimmer"/>
      <div className="orb__core">
        {star && <Spark size={size*0.17} color="#fff" style={{filter:'drop-shadow(0 1px 4px rgba(60,30,100,.45))'}} className="orb__star"/>}
      </div>
      <div className="orb__orbiter" style={{top:'50%',left:'50%',margin:'-3.5px'}}/>
    </div>
  );
}
// equalizer
function Equalizer({bars=10, wide=false, faint=false, color}) {
  return (
    <div className={'eq'+(wide?' wide':'')+(faint?' faint':'')}>
      {Array.from({length:bars}).map((_,i)=><i key={i} style={color?{background:color}:undefined}/>)}
    </div>
  );
}

/* ───────────────────────── Wordmark ───────────────────────── */
function Wordmark({size=34, color='var(--ink)', tagline=false}) {
  return (
    <div style={{display:'inline-flex',flexDirection:'column',gap:tagline?6:0}}>
      <div style={{position:'relative',display:'inline-flex',alignItems:'flex-start'}}>
        <span className="serif" style={{fontSize:size,fontWeight:600,letterSpacing:'.01em',color,lineHeight:.9}}>Viva</span>
        <Spark size={size*0.34} color="var(--plum)" style={{position:'absolute',top:-size*0.16,right:-size*0.26}}/>
      </div>
      {tagline && <span className="kicker" style={{fontSize:size*0.26}}>Voice-first study companion</span>}
    </div>
  );
}

/* ───────────────────────── Context Pill ───────────────────────── */
function ContextPill({items=['Biology Midterm','3 docs','Exam Friday'], small=false}) {
  return (
    <span className="chip" style={{background:'var(--paper-2)',border:'1px solid var(--line)',
      padding:small?'6px 13px':'8px 16px',boxShadow:'var(--shadow-sm)',fontSize:small?12.5:13.5,color:'var(--ink-2)'}}>
      <Icon name="layers" size={small?13:15} color="var(--plum)"/>
      {items.map((t,i)=>(
        <React.Fragment key={i}>
          {i>0 && <span style={{color:'var(--ink-4)',margin:'0 1px'}}>·</span>}
          <span style={{fontWeight:i===0?600:500,color:i===0?'var(--ink)':'var(--ink-2)'}}>{t}</span>
        </React.Fragment>
      ))}
    </span>
  );
}

/* ───────────────────────── Mode Chip ───────────────────────── */
const MODE_ICON = {quiz:'quiz',teach:'cap',mock:'mic',cram:'bolt'};
function ModeChip({mode='quiz', label, active=false, sub, onClick}) {
  const ic = MODE_ICON[mode]||'quiz';
  return (
    <button onClick={onClick} className="chip" style={{cursor:'pointer',border:active?'1px solid transparent':'1px solid var(--line)',
      background:active?'var(--ink)':'var(--paper-2)',color:active?'#fff':'var(--ink)',
      padding:'11px 18px',fontSize:14,fontWeight:600,boxShadow:active?'var(--shadow-md)':'var(--shadow-sm)',
      gap:9,transition:'all .2s'}}>
      <Icon name={ic} size={16} color={active?'var(--plum-soft)':'var(--plum)'}/>
      {label}
    </button>
  );
}

/* ───────────────────────── Source Chip ───────────────────────── */
function SourceChip({label='Lecture 5 · slide 12', tone='plum'}) {
  const c = tone==='plum'?['var(--plum)','var(--plum-wash)']:['var(--ink-2)','var(--paper-2)'];
  return (
    <span className="chip" style={{background:c[1],color:c[0],padding:'5px 11px',fontSize:12,fontWeight:600,
      border:'1px solid '+(tone==='plum'?'var(--plum-line)':'var(--line)')}}>
      <Icon name="doc" size={12.5} sw={1.8}/>{label}
    </span>
  );
}

/* ───────────────────────── Mastery Chip ───────────────────────── */
const TIER = {
  strong:{c:'var(--sage)',w:'var(--sage-wash)',label:'Strong'},
  shaky:{c:'var(--amber)',w:'var(--amber-wash)',label:'Shaky'},
  review:{c:'var(--plum)',w:'var(--plum-wash)',label:'Review'},
};
function MasteryChip({tier='strong', label, pct}) {
  const t = TIER[tier];
  return (
    <span className="chip" style={{background:t.w,color:t.c,padding:'6px 12px 6px 9px',fontSize:12.5,fontWeight:600,border:'1px solid '+t.c+'22'}}>
      <span style={{width:7,height:7,borderRadius:'50%',background:t.c}}/>
      {label}{pct!=null && <span style={{opacity:.7,fontWeight:500}}>· {pct}%</span>}
    </span>
  );
}

/* ───────────────────────── Mastery Ring (donut) ───────────────────────── */
function MasteryRing({pct=72, size=88, stroke=8, color='var(--sage)', track='rgba(44,37,54,.08)', children, label}) {
  const r=(size-stroke)/2, c=2*Math.PI*r, off=c*(1-pct/100);
  return (
    <div style={{position:'relative',width:size,height:size,display:'grid',placeItems:'center'}}>
      <svg width={size} height={size} style={{transform:'rotate(-90deg)'}}>
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={track} strokeWidth={stroke}/>
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={color} strokeWidth={stroke} strokeLinecap="round"
          strokeDasharray={c} strokeDashoffset={off}/>
      </svg>
      <div style={{position:'absolute',textAlign:'center'}}>
        {children!=null?children:<><div className="serif" style={{fontSize:size*0.32,fontWeight:600,lineHeight:1,color:'var(--ink)'}}>{pct}<span style={{fontSize:size*0.16}}>%</span></div>{label&&<div className="cap" style={{fontSize:10.5,marginTop:2}}>{label}</div>}</>}
      </div>
    </div>
  );
}

/* ───────────────────────── Action / Generated Card ───────────────────────── */
function ActionCard({icon='target', kicker, title, sub, accent='plum', primary=false, arrow=true, wide=false, style}) {
  const map={plum:'var(--plum)',sage:'var(--sage)',gold:'var(--gold)',amber:'var(--amber)'};
  const ac=map[accent]||map.plum;
  return (
    <div style={{position:'relative',background:primary?'var(--ink)':'var(--paper)',border:'1px solid '+(primary?'transparent':'var(--line)'),
      borderRadius:'var(--radius)',padding:'20px 22px',boxShadow:primary?'var(--shadow-md)':'var(--shadow-sm)',
      display:'flex',flexDirection:'column',gap:wide?14:10,minHeight:wide?0:150,...style}}>
      <div style={{display:'flex',alignItems:'center',justifyContent:'space-between'}}>
        <span style={{width:34,height:34,borderRadius:10,display:'grid',placeItems:'center',
          background:primary?'rgba(255,255,255,.12)':(accent==='plum'?'var(--plum-wash)':accent==='sage'?'var(--sage-wash)':'var(--gold-wash)')}}>
          <Icon name={icon} size={17} color={primary?'var(--plum-soft)':ac}/>
        </span>
        {kicker && <span className="kicker" style={{fontSize:10,color:primary?'rgba(255,255,255,.6)':'var(--ink-3)'}}>{kicker}</span>}
      </div>
      <div style={{flex:1}}>
        <div className="serif" style={{fontSize:wide?23:25,fontWeight:600,lineHeight:1.05,color:primary?'#fff':'var(--ink)',letterSpacing:'-.01em'}}>{title}</div>
        {sub && <div style={{fontSize:13,color:primary?'rgba(255,255,255,.66)':'var(--ink-3)',marginTop:6,lineHeight:1.4}}>{sub}</div>}
      </div>
      {arrow && <div style={{display:'flex',justifyContent:'flex-end'}}>
        <span style={{width:30,height:30,borderRadius:'50%',display:'grid',placeItems:'center',
          background:primary?'#fff':'transparent',border:primary?'none':'1px solid var(--line)'}}>
          <Icon name="arrow" size={15} color={primary?'var(--ink)':'var(--ink-2)'}/>
        </span>
      </div>}
    </div>
  );
}

/* ───────────────────────── Timeline Item ───────────────────────── */
function TimelineItem({status='upcoming', day, topics, meta, last=false}) {
  const cfg = {done:{c:'var(--sage)'},today:{c:'var(--plum)'},upcoming:{c:'var(--ink-4)'}}[status];
  return (
    <div style={{display:'flex',gap:14,position:'relative'}}>
      <div style={{display:'flex',flexDirection:'column',alignItems:'center'}}>
        <span style={{width:22,height:22,borderRadius:'50%',display:'grid',placeItems:'center',flex:'none',
          background:status==='done'?'var(--sage)':status==='today'?'var(--plum)':'transparent',
          border:status==='upcoming'?'1.5px solid var(--ink-4)':'none'}}>
          {status==='done'&&<Icon name="check" size={13} color="#fff" sw={2.2}/>}
          {status==='today'&&<span style={{width:7,height:7,borderRadius:'50%',background:'#fff'}}/>}
        </span>
        {!last && <span style={{flex:1,width:1.5,background:'var(--line)',marginTop:3}}/>}
      </div>
      <div style={{paddingBottom:last?0:20,flex:1,display:'flex',justifyContent:'space-between',gap:12}}>
        <div>
          <div style={{fontSize:14,fontWeight:600,color:'var(--ink)'}}>{day}</div>
          <div style={{fontSize:13,color:'var(--ink-3)',marginTop:2}}>{topics}</div>
        </div>
        <div style={{fontSize:12.5,color:status==='done'?'var(--sage)':'var(--ink-3)',fontWeight:status==='done'?600:500,whiteSpace:'nowrap'}}>{meta}</div>
      </div>
    </div>
  );
}

/* ───────────────────────── Mobile Action Button ───────────────────────── */
function MobileButton({icon, label, variant='ghost', sub}) {
  const fill=variant==='fill';
  return (
    <button className="chip" style={{justifyContent:'center',width:'100%',cursor:'pointer',gap:9,
      background:fill?'var(--ink)':'var(--plum-wash)',color:fill?'#fff':'var(--plum)',
      border:fill?'none':'1px solid var(--plum-line)',padding:'14px',fontSize:15,fontWeight:600,
      boxShadow:fill?'var(--shadow-md)':'none'}}>
      {icon&&<Icon name={icon} size={17} color={fill?'var(--plum-soft)':'var(--plum)'}/>}{label}
    </button>
  );
}

/* ───────────────────────── Avatar ───────────────────────── */
function Avatar({size=34, initial='A'}) {
  return (
    <span style={{width:size,height:size,borderRadius:'50%',display:'grid',placeItems:'center',flex:'none',
      background:'radial-gradient(circle at 35% 30%,#caa9ea,#7a5ba6)',color:'#fff',fontWeight:600,fontSize:size*0.4,
      boxShadow:'inset 0 -2px 6px rgba(40,20,70,.3)'}}>{initial}</span>
  );
}

/* ───────────────────────── Transcript line ───────────────────────── */
function TranscriptLine({who='viva', text, time}) {
  const viva = who==='viva';
  return (
    <div style={{display:'flex',gap:10,opacity:viva?1:.92}}>
      <span style={{width:24,height:24,borderRadius:'50%',flex:'none',display:'grid',placeItems:'center',marginTop:1,
        background:viva?'var(--plum-wash)':'var(--paper-2)',border:'1px solid '+(viva?'var(--plum-line)':'var(--line)')}}>
        {viva?<Spark size={12} color="var(--plum)"/>:<Icon name="mic" size={12} color="var(--ink-3)"/>}
      </span>
      <div style={{flex:1}}>
        <div style={{display:'flex',alignItems:'baseline',gap:8}}>
          <span style={{fontSize:12.5,fontWeight:700,color:viva?'var(--plum)':'var(--ink-2)'}}>{viva?'Viva':'You'}</span>
          {time&&<span style={{fontSize:11,color:'var(--ink-4)',fontVariantNumeric:'tabular-nums'}}>{time}</span>}
        </div>
        <div style={{fontSize:13.5,color:'var(--ink-2)',lineHeight:1.45,marginTop:2}}>{text}</div>
      </div>
    </div>
  );
}

/* ───────────────────────── Next-step / feedback card ───────────────────────── */
function FeedbackCard({icon='refresh', title, sub, accent='plum'}) {
  const map={plum:'var(--plum)',sage:'var(--sage)',gold:'var(--gold)',amber:'var(--amber)'};
  return (
    <button className="" style={{display:'flex',alignItems:'center',gap:12,width:'100%',textAlign:'left',cursor:'pointer',
      background:'var(--paper-2)',border:'1px solid var(--line)',borderRadius:14,padding:'13px 15px',boxShadow:'var(--shadow-sm)'}}>
      <span style={{width:32,height:32,borderRadius:9,flex:'none',display:'grid',placeItems:'center',background:map[accent]+'1a'}}>
        <Icon name={icon} size={16} color={map[accent]}/>
      </span>
      <span style={{flex:1}}>
        <span style={{display:'block',fontSize:13.5,fontWeight:600,color:'var(--ink)'}}>{title}</span>
        {sub&&<span style={{display:'block',fontSize:12,color:'var(--ink-3)',marginTop:1}}>{sub}</span>}
      </span>
      <Icon name="chevron" size={15} color="var(--ink-4)"/>
    </button>
  );
}

Object.assign(window, {
  Icon, Spark, Sprig, VoiceOrb, Equalizer, Wordmark, ContextPill, ModeChip,
  SourceChip, MasteryChip, MasteryRing, ActionCard, TimelineItem, MobileButton,
  Avatar, TranscriptLine, FeedbackCard,
});
