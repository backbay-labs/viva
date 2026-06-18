// viva-session.jsx — live voice session: states, modes, correction
const { F } = window;
const { VoiceOrb, Wordmark, Spark, Icon, Equalizer, ContextPill, ModeChip,
  SourceChip, MasteryChip, TranscriptLine, FeedbackCard } = window;

function SessTop({mode='Quiz me'}) {
  return (
    <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',padding:'18px 26px',
      borderBottom:'1px solid var(--line)'}}>
      <div className="chip" style={{gap:8,fontSize:14.5,fontWeight:600,color:'var(--ink)',cursor:'pointer'}}>
        <Icon name="layers" size={15} color="var(--plum)"/> Biology Midterm
        <Icon name="down" size={13} color="var(--ink-3)"/>
        <span style={{color:'var(--ink-4)',margin:'0 2px'}}>·</span>
        <span style={{fontSize:13,fontWeight:600,color:'var(--plum)'}}>{mode}</span>
      </div>
      <button className="chip" style={{background:'transparent',border:'1px solid var(--amber)55',color:'var(--amber)',
        padding:'8px 15px',fontSize:13,fontWeight:600,cursor:'pointer',gap:7}}>
        <span style={{width:7,height:7,borderRadius:'50%',background:'var(--amber)'}}/> End session
      </button>
    </div>
  );
}

function CenterStage({state='ready', label, timer='07:32', size=176}) {
  return (
    <div style={{display:'flex',flexDirection:'column',alignItems:'center',gap:14}}>
      <div style={{textAlign:'center'}}>
        <span className="serif" style={{fontSize:34,fontWeight:600,color:'var(--ink)',fontVariantNumeric:'tabular-nums',letterSpacing:'.01em'}}>{timer}</span>
        <span className="cap" style={{fontSize:12,marginLeft:4}}>min</span>
      </div>
      <VoiceOrb size={size} state={state}/>
      <div style={{display:'flex',flexDirection:'column',alignItems:'center',gap:9,minHeight:30}}>
        {label && <div style={{fontSize:14.5,fontWeight:600,color:'var(--plum)'}}>{label}</div>}
        {state==='listening' && <Equalizer bars={12} wide/>}
      </div>
    </div>
  );
}

/* ── Ready: one question, nothing else ── */
function SessionReadyBoard() {
  return (
    <F bg="var(--bg-deep)" style={{display:'flex',flexDirection:'column'}}>
      <SessTop mode="Quiz me"/>
      <div style={{flex:1,display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',padding:'40px 80px',gap:30}}>
        <div className="kicker" style={{fontSize:10}}>Question 1 of 8 · Quiz me</div>
        <h1 className="display" style={{fontSize:42,textAlign:'center',lineHeight:1.12,maxWidth:680,margin:0}}>
          What is the net output of ATP from one glucose during aerobic respiration?
        </h1>
        <VoiceOrb size={150} state="ready"/>
        <div style={{display:'flex',alignItems:'center',gap:9,color:'var(--ink-3)',fontSize:14}}>
          <Icon name="mic" size={16} color="var(--plum)"/> Tap the orb and answer out loud — close your notes.
        </div>
      </div>
    </F>
  );
}

/* ── Listening: UI collapses while the student speaks ── */
function SessionListeningBoard() {
  return (
    <F bg="var(--bg-deep)" style={{display:'flex',flexDirection:'column'}}>
      <SessTop mode="Quiz me"/>
      <div style={{flex:1,display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',padding:'40px',gap:8,position:'relative'}}>
        <div style={{position:'absolute',top:26,left:0,right:0,textAlign:'center'}}>
          <span className="cap" style={{fontSize:12.5}}>You’re answering</span>
          <div style={{fontSize:16,color:'var(--ink-3)',marginTop:4,maxWidth:520,margin:'4px auto 0'}}>What is the net output of ATP from one glucose during aerobic respiration?</div>
        </div>
        <CenterStage state="listening" label="Listening…" timer="07:32" size={196}/>
        <div style={{fontSize:13.5,color:'var(--ink-3)',marginTop:6}}>Take your time — Viva won’t interrupt.</div>
      </div>
    </F>
  );
}

/* ── Feedback: orb expands into transcript + next actions ── */
function SessionFeedbackBoard() {
  return (
    <F bg="var(--bg-deep)" style={{display:'flex',flexDirection:'column'}}>
      <SessTop mode="Quiz me"/>
      <div style={{flex:1,display:'grid',gridTemplateColumns:'318px 1fr 290px',gap:0,minHeight:0}}>
        {/* transcript */}
        <div style={{borderRight:'1px solid var(--line)',padding:'22px 22px',display:'flex',flexDirection:'column',gap:18,overflow:'hidden'}}>
          <div className="kicker" style={{fontSize:10,display:'flex',alignItems:'center',gap:7}}><Icon name="bars" size={13} color="var(--plum)"/> Live transcript</div>
          <TranscriptLine who="viva" time="07:02" text="What’s the net output of ATP from one glucose during aerobic respiration?"/>
          <TranscriptLine who="you" time="07:18" text="I think it’s 36 ATP."/>
          <TranscriptLine who="viva" time="07:28" text="Almost — that’s the classic textbook figure. For this course it’s closer to 30–32. Want to see why?"/>
        </div>
        {/* center */}
        <div style={{display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',gap:0,padding:'20px'}}>
          <CenterStage state="thinking" label="Responding…" timer="07:32" size={176}/>
        </div>
        {/* what's next */}
        <div style={{borderLeft:'1px solid var(--line)',padding:'22px 20px',display:'flex',flexDirection:'column',gap:11}}>
          <div className="kicker" style={{fontSize:10}}>What’s next?</div>
          <FeedbackCard icon="pen" title="Try again with an example" sub="Explain via the shuttle systems"/>
          <FeedbackCard icon="bulb" title="Need a hint?" sub="A nudge in the right direction" accent="gold"/>
          <FeedbackCard icon="doc" title="Show source" sub="Lecture 5 · slide 12" accent="plum"/>
          <FeedbackCard icon="flag" title="Mark as shaky" sub="Bring it back tomorrow" accent="amber"/>
        </div>
      </div>
      {/* listening footer */}
      <div style={{borderTop:'1px solid var(--line)',padding:'13px 26px',display:'flex',alignItems:'center',gap:12,background:'var(--paper)'}}>
        <Spark size={14} color="var(--plum)"/>
        <span style={{fontSize:13,fontWeight:600,color:'var(--ink-2)'}}>Viva is listening</span>
        <Equalizer bars={26} faint/>
        <div style={{flex:1}}/>
        <span className="cap" style={{fontSize:12}}>Hold space to pause</span>
      </div>
    </F>
  );
}

/* ── Correction + source moment ── */
function CorrectionBoard() {
  return (
    <F bg="var(--bg-deep)" style={{display:'flex',flexDirection:'column'}}>
      <SessTop mode="Quiz me"/>
      <div style={{flex:1,display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',padding:'30px 56px',gap:22}}>
        <div style={{display:'flex',alignItems:'center',gap:18}}>
          <VoiceOrb size={92} state="correcting"/>
          <div>
            <div className="kicker" style={{fontSize:10,color:'var(--amber)'}}>Gentle correction</div>
            <h2 className="display" style={{fontSize:34,margin:'3px 0 0'}}>Almost — let’s sharpen it.</h2>
          </div>
        </div>

        <div style={{display:'grid',gridTemplateColumns:'1fr 320px',gap:20,width:880,alignItems:'stretch'}}>
          {/* correction */}
          <div className="v-soft-card" style={{padding:'24px 26px',display:'flex',flexDirection:'column',gap:16,boxShadow:'var(--shadow-md)'}}>
            <div style={{display:'flex',gap:10,alignItems:'baseline'}}>
              <span style={{fontSize:12.5,fontWeight:700,color:'var(--ink-3)',flex:'none'}}>You said</span>
              <span style={{fontSize:15,color:'var(--ink-2)'}}>“I think it produces 36 ATP.”</span>
            </div>
            <hr className="thin-divider"/>
            <p className="serif" style={{fontSize:21,fontStyle:'italic',fontWeight:500,color:'var(--ink)',lineHeight:1.35,margin:0}}>
              “Close. For this course, your professor uses <span style={{color:'var(--plum-deep)',fontStyle:'normal',fontWeight:600}}>30–32 ATP</span> — the difference is the shuttle system that moves NADH into the mitochondria.”
            </p>
            <div style={{display:'flex',alignItems:'center',gap:10,marginTop:2}}>
              <MasteryChip tier="shaky" label="Marked shaky"/>
              <span className="cap" style={{fontSize:12}}>Confidence dipped — we’ll revisit tomorrow</span>
            </div>
          </div>
          {/* source */}
          <div className="v-soft-card" style={{padding:'18px',display:'flex',flexDirection:'column',gap:12,background:'var(--paper-2)'}}>
            <div className="kicker" style={{fontSize:9.5,display:'flex',alignItems:'center',gap:7}}><Icon name="doc" size={13} color="var(--plum)"/> Source</div>
            <div style={{borderRadius:12,border:'1px solid var(--plum-line)',background:'#fff',padding:'16px 16px',flex:1,position:'relative',overflow:'hidden'}}>
              <div className="cap" style={{fontSize:10.5,marginBottom:8}}>Lecture 5 · slide 12</div>
              <div style={{fontSize:13,fontWeight:700,color:'var(--ink)',marginBottom:8}}>ATP accounting</div>
              {['Glycolysis → 2 ATP','Krebs cycle → 2 ATP','Oxidative phosphorylation'].map((t,i)=>(
                <div key={i} style={{fontSize:11.5,color:'var(--ink-2)',padding:'3px 0',display:'flex',gap:6}}><span style={{color:'var(--ink-4)'}}>·</span>{t}</div>
              ))}
              <div style={{marginTop:8,background:'var(--gold-wash)',borderLeft:'2px solid var(--gold)',padding:'6px 10px',
                fontSize:11.5,fontWeight:600,color:'var(--ink)',borderRadius:'0 6px 6px 0'}}>≈ 30–32 ATP (shuttle-dependent)</div>
            </div>
            <SourceChip label="Open in Lecture 5"/>
          </div>
        </div>

        <div style={{display:'flex',gap:11}}>
          <button className="chip" style={{background:'var(--ink)',color:'#fff',border:'none',padding:'13px 24px',fontSize:14.5,fontWeight:600,cursor:'pointer',gap:9}}>
            <Icon name="refresh" size={16} color="var(--plum-soft)"/> Try again
          </button>
          <button className="chip" style={{background:'var(--paper-2)',color:'var(--ink)',border:'1px solid var(--line)',padding:'13px 22px',fontSize:14.5,fontWeight:600,cursor:'pointer',gap:9}}>
            <Icon name="cap" size={16} color="var(--plum)"/> Explain with shuttle systems
          </button>
        </div>
      </div>
    </F>
  );
}

/* ── Mode frames: how the session UI shifts per mode ── */
function ModeFrame({mode, title, kicker, orb, accent='plum', children, footer}) {
  return (
    <F bg="var(--bg-deep)" style={{display:'flex',flexDirection:'column',padding:'22px 22px 20px'}}>
      <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:6}}>
        <ModeChip mode={mode} label={title} active/>
        <span className="serif" style={{fontSize:18,fontWeight:600,color:'var(--ink)',fontVariantNumeric:'tabular-nums'}}>04:18</span>
      </div>
      <div style={{flex:1,display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',gap:14,textAlign:'center'}}>
        <VoiceOrb size={96} state={orb}/>
        <div className="kicker" style={{fontSize:9.5,color:'var(--'+accent+')'}}>{kicker}</div>
        <div className="serif" style={{fontSize:24,fontWeight:600,color:'var(--ink)',lineHeight:1.15,maxWidth:380}}>{title==='Quiz me'?'How many ATP from glycolysis alone?':title==='Teach me'?'Let me walk you through the electron transport chain.':title==='Mock viva'?'Define oxidative phosphorylation — then I’ll push further.':'ATP yield depends on which shuttle?'}</div>
        {children}
      </div>
      {footer}
    </F>
  );
}
function QuizModeBoard() {
  return (
    <ModeFrame mode="quiz" title="Quiz me" kicker="Fast active recall · Q3 of 12" orb="ready" accent="plum"
      footer={
        <div style={{display:'flex',gap:8}}>
          <button className="chip" style={{flex:1,justifyContent:'center',background:'var(--sage-wash)',color:'var(--sage)',border:'1px solid var(--sage)33',padding:'11px',fontSize:13.5,fontWeight:600,cursor:'pointer'}}><Icon name="check" size={15} color="var(--sage)"/> Got it</button>
          <button className="chip" style={{flex:1,justifyContent:'center',background:'var(--paper-2)',color:'var(--ink-2)',border:'1px solid var(--line)',padding:'11px',fontSize:13.5,fontWeight:600,cursor:'pointer'}}>Skip</button>
        </div>}>
      <span className="chip" style={{background:'var(--sage-wash)',color:'var(--sage)',padding:'5px 12px',fontSize:12,fontWeight:600}}><Icon name="check" size={13} color="var(--sage)"/> Last answer correct · 1.2s</span>
    </ModeFrame>
  );
}
function TeachModeBoard() {
  return (
    <ModeFrame mode="teach" title="Teach me" kicker="Conversational · explain then check" orb="encouraging" accent="sage"
      footer={<button className="chip" style={{width:'100%',justifyContent:'center',background:'var(--ink)',color:'#fff',border:'none',padding:'12px',fontSize:14,fontWeight:600,cursor:'pointer',gap:9}}><Icon name="mic" size={16} color="var(--plum-soft)"/> Now explain it back</button>}>
      <p style={{fontSize:13.5,color:'var(--ink-2)',lineHeight:1.5,maxWidth:360,margin:0}}>Electrons from NADH and FADH₂ pass down a chain of proteins, pumping protons to build a gradient…</p>
    </ModeFrame>
  );
}
function MockModeBoard() {
  return (
    <ModeFrame mode="mock" title="Mock viva" kicker="Strict · no hints · follow-ups" orb="recall" accent="plum"
      footer={
        <div style={{textAlign:'center'}}>
          <div className="cap" style={{fontSize:11.5,marginBottom:8}}>Examiner mode — answer fully, then expect a follow-up.</div>
          <Equalizer bars={18} faint/>
        </div>}>
      <span className="chip" style={{background:'var(--paper-2)',color:'var(--ink-2)',border:'1px solid var(--line)',padding:'5px 12px',fontSize:12,fontWeight:600}}>Follow-up loaded · 2 of 3</span>
    </ModeFrame>
  );
}
function CramModeBoard() {
  return (
    <ModeFrame mode="cram" title="Cram" kicker="Highest-yield weak areas first" orb="recall" accent="amber"
      footer={
        <div>
          <div style={{display:'flex',justifyContent:'space-between',fontSize:11.5,color:'var(--ink-3)',marginBottom:6}}><span>Weak areas</span><span style={{fontWeight:600,color:'var(--amber)'}}>4 left</span></div>
          <div style={{height:6,borderRadius:3,background:'var(--line)',overflow:'hidden'}}><div style={{width:'66%',height:'100%',background:'var(--amber)',borderRadius:3}}/></div>
        </div>}>
      <span className="chip" style={{background:'var(--amber-wash)',color:'var(--amber)',padding:'5px 12px',fontSize:12,fontWeight:600}}><Icon name="bolt" size={12} color="var(--amber)" fill/> Exam tomorrow · prioritized</span>
    </ModeFrame>
  );
}

/* ── Mobile session ── */
function SessionMobileBoard() {
  return (
    <F bg="var(--bg-deep)" style={{display:'flex',flexDirection:'column',padding:'48px 18px 24px'}}>
      <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:8}}>
        <Icon name="x" size={19} color="var(--ink-2)"/>
        <div className="chip" style={{fontSize:13.5,fontWeight:600,color:'var(--ink)'}}><Icon name="layers" size={13} color="var(--plum)"/> Biology · Quiz me</div>
        <Icon name="sliders" size={18} color="var(--ink-2)"/>
      </div>
      <div style={{flex:1,display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',gap:14}}>
        <div style={{textAlign:'center'}}><span className="serif" style={{fontSize:30,fontWeight:600,color:'var(--ink)',fontVariantNumeric:'tabular-nums'}}>06:48</span><span className="cap" style={{fontSize:11,marginLeft:3}}>min</span></div>
        <VoiceOrb size={158} state="listening"/>
        <div style={{fontSize:14,fontWeight:600,color:'var(--plum)'}}>Listening…</div>
        <Equalizer bars={14} wide/>
      </div>
      <div style={{marginBottom:14}}>
        <div className="cap" style={{fontSize:11.5,marginBottom:6,textAlign:'center'}}>Current question</div>
        <p className="serif" style={{fontSize:21,fontWeight:600,color:'var(--ink)',textAlign:'center',lineHeight:1.2,margin:0}}>Explain the role of NADH in oxidative phosphorylation.</p>
      </div>
      <div style={{display:'flex',gap:9}}>
        <button className="chip" style={{flex:1,justifyContent:'center',background:'var(--plum-wash)',color:'var(--plum)',border:'1px solid var(--plum-line)',padding:'13px',fontSize:14,fontWeight:600,cursor:'pointer'}}><Icon name="bulb" size={16} color="var(--plum)"/> Hint</button>
        <button className="chip" style={{flex:1,justifyContent:'center',background:'var(--paper-2)',color:'var(--ink-2)',border:'1px solid var(--line)',padding:'13px',fontSize:14,fontWeight:600,cursor:'pointer'}}><Icon name="doc" size={15} color="var(--ink-3)"/> Source</button>
      </div>
    </F>
  );
}
function SessionMobileFeedbackBoard() {
  return (
    <F bg="var(--bg-deep)" style={{display:'flex',flexDirection:'column',padding:'48px 18px 24px'}}>
      <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:14}}>
        <Icon name="x" size={19} color="var(--ink-2)"/>
        <div className="chip" style={{fontSize:13.5,fontWeight:600,color:'var(--ink)'}}><Icon name="layers" size={13} color="var(--plum)"/> Biology · Quiz me</div>
        <Icon name="sliders" size={18} color="var(--ink-2)"/>
      </div>
      <div style={{display:'flex',flexDirection:'column',alignItems:'center',gap:10,marginBottom:16}}>
        <VoiceOrb size={104} state="correcting"/>
        <span className="chip" style={{background:'var(--amber-wash)',color:'var(--amber)',padding:'5px 12px',fontSize:11.5,fontWeight:600}}>Gentle correction</span>
      </div>
      <p className="serif" style={{fontSize:19,fontStyle:'italic',fontWeight:500,color:'var(--ink)',textAlign:'center',lineHeight:1.32,margin:'0 0 14px'}}>
        “Close — it’s 30–32 ATP for this course. The shuttle system is the key.”
      </p>
      <div style={{display:'flex',justifyContent:'center',marginBottom:18}}><SourceChip label="Lecture 5 · slide 12"/></div>
      <div style={{flex:1}}/>
      <div style={{display:'flex',flexDirection:'column',gap:9}}>
        <button className="chip" style={{width:'100%',justifyContent:'center',background:'var(--ink)',color:'#fff',border:'none',padding:'13px',fontSize:14.5,fontWeight:600,cursor:'pointer',gap:9}}><Icon name="refresh" size={16} color="var(--plum-soft)"/> Try again with an example</button>
        <button className="chip" style={{width:'100%',justifyContent:'center',background:'var(--paper-2)',color:'var(--ink)',border:'1px solid var(--line)',padding:'13px',fontSize:14,fontWeight:600,cursor:'pointer',gap:9}}><Icon name="flag" size={15} color="var(--amber)"/> Mark as shaky</button>
      </div>
    </F>
  );
}

Object.assign(window, {
  SessionReadyBoard, SessionListeningBoard, SessionFeedbackBoard, CorrectionBoard,
  QuizModeBoard, TeachModeBoard, MockModeBoard, CramModeBoard,
  SessionMobileBoard, SessionMobileFeedbackBoard,
});
