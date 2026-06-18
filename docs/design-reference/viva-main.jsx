// viva-main.jsx — composes the full Viva design canvas
const { DesignCanvas, DCSection, DCArtboard, F, Icon, Spark, VoiceOrb } = window;

/* ── Interaction model board (deliverable #3) ── */
function InteractionBoard() {
  const phases=[
    {ic:'home',h:'Before a session',c:'var(--plum)',pts:['One dominant CTA, sized to exam proximity','Weak concepts orbit the orb as chips','Home regenerates daily from memory decay']},
    {ic:'mic',h:'While you speak',c:'var(--sage)',pts:['UI collapses to orb + waveform','No cards, no chrome — only the question','Viva listens without interrupting']},
    {ic:'pen',h:'After an answer',c:'var(--gold)',pts:['Orb expands into 2–4 next actions','Try again · Hint · Show source · Mark shaky','Only what this answer needs']},
    {ic:'graph',h:'After the session',c:'var(--amber)',pts:['Recap: strong / shaky / review','A plan keyed to your exam date','Source-linked moments to revisit']},
  ];
  return (
    <F bg="var(--paper)" style={{padding:'38px 40px',display:'flex',flexDirection:'column',gap:26}}>
      <div>
        <span className="kicker">Interaction model · generative UI</span>
        <h2 className="display" style={{fontSize:30,margin:'10px 0 0'}}>The interface reveals only what matters next.</h2>
      </div>
      <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:18}}>
        {phases.map((p,i)=>(
          <div key={i} style={{display:'flex',flexDirection:'column',gap:13}}>
            <div style={{display:'flex',alignItems:'center',gap:10}}>
              <span style={{width:30,height:30,borderRadius:9,display:'grid',placeItems:'center',background:p.c+'1a'}}><Icon name={p.ic} size={16} color={p.c}/></span>
              <span style={{fontSize:10,fontWeight:700,color:'var(--ink-3)',fontVariantNumeric:'tabular-nums'}}>0{i+1}</span>
            </div>
            <div style={{fontSize:15.5,fontWeight:700,color:'var(--ink)'}}>{p.h}</div>
            <div style={{display:'flex',flexDirection:'column',gap:8}}>
              {p.pts.map((t,j)=>(
                <div key={j} style={{display:'flex',gap:8,fontSize:12.5,color:'var(--ink-2)',lineHeight:1.4}}>
                  <span style={{width:5,height:5,borderRadius:'50%',background:p.c,flex:'none',marginTop:6}}/>{t}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
      <div style={{display:'flex',alignItems:'center',gap:14,background:'var(--bg)',border:'1px solid var(--line)',borderRadius:'var(--radius)',padding:'18px 22px'}}>
        <Spark size={18} color="var(--plum)"/>
        <div style={{fontSize:13.5,color:'var(--ink-2)',lineHeight:1.45}}>
          <span style={{fontWeight:700,color:'var(--ink)'}}>How Viva chooses cards:</span> it weighs exam proximity, memory decay since last recall, concepts you missed, and the confidence it heard in your last answer — then surfaces the 1–4 actions most likely to move you forward. Never a fixed dashboard.
        </div>
      </div>
    </F>
  );
}

function App() {
  const D = (id,label,w,h,Comp,extra) => (
    <DCArtboard id={id} label={label} width={w} height={h} {...(extra||{})}><Comp/></DCArtboard>
  );
  return (
    <DesignCanvas>
      <DCSection id="identity" title="Identity & System" subtitle="The Viva visual language — calm, scholarly, voice-first">
        <DCArtboard id="wordmark" label="Wordmark" width={440} height={380}><window.WordmarkBoard/></DCArtboard>
        <DCArtboard id="type" label="Typography" width={600} height={540}><window.TypeBoard/></DCArtboard>
        <DCArtboard id="palette" label="Palette" width={520} height={540}><window.PaletteBoard/></DCArtboard>
        <DCArtboard id="orb" label="Voice orb · states" width={960} height={580}><window.OrbStatesBoard/></DCArtboard>
        <DCArtboard id="components" label="Component system" width={760} height={560}><window.ComponentsBoard/></DCArtboard>
      </DCSection>

      <DCSection id="onboarding" title="Onboarding" subtitle="“What are we studying?” — uploading should feel effortless and magical">
        <DCArtboard id="upload" label="Upload · first run" width={1180} height={760}><window.UploadEmptyBoard/></DCArtboard>
        <DCArtboard id="studyset" label="Generated study set" width={1180} height={760}><window.StudySetBoard/></DCArtboard>
        <DCArtboard id="upload-m" label="Mobile · upload" width={390} height={800}><window.UploadMobileBoard/></DCArtboard>
      </DCSection>

      <DCSection id="home" title="Generative Home" subtitle="A calm study cockpit that regenerates around your context — not a dashboard">
        <DCArtboard id="home-d" label="Home · desktop" width={1180} height={820}><window.HomeBoard/></DCArtboard>
        <DCArtboard id="home-exam" label="Home · regenerated (exam tomorrow)" width={1180} height={820}><window.HomeExamBoard/></DCArtboard>
        <DCArtboard id="home-m" label="Home · mobile" width={390} height={820}><window.HomeMobileBoard/></DCArtboard>
      </DCSection>

      <DCSection id="session" title="Live Voice Session" subtitle="The heart of Viva — a focused study call, not a chat with a mic button">
        <DCArtboard id="sess-ready" label="Ready · one question" width={1180} height={780}><window.SessionReadyBoard/></DCArtboard>
        <DCArtboard id="sess-listen" label="Listening · UI collapses" width={1180} height={780}><window.SessionListeningBoard/></DCArtboard>
        <DCArtboard id="sess-feedback" label="Feedback · orb expands into cards" width={1180} height={780}><window.SessionFeedbackBoard/></DCArtboard>
        <DCArtboard id="correction" label="Correction + source" width={1180} height={780}><window.CorrectionBoard/></DCArtboard>
        <DCArtboard id="sess-m" label="Mobile · listening" width={390} height={820}><window.SessionMobileBoard/></DCArtboard>
        <DCArtboard id="sess-m-fb" label="Mobile · correction" width={390} height={820}><window.SessionMobileFeedbackBoard/></DCArtboard>
      </DCSection>

      <DCSection id="modes" title="Study Modes" subtitle="Quiz · Teach · Mock viva · Cram — lightweight states of one session, not separate products">
        <DCArtboard id="m-quiz" label="Quiz me" width={560} height={560}><window.QuizModeBoard/></DCArtboard>
        <DCArtboard id="m-teach" label="Teach me" width={560} height={560}><window.TeachModeBoard/></DCArtboard>
        <DCArtboard id="m-mock" label="Mock viva" width={560} height={560}><window.MockModeBoard/></DCArtboard>
        <DCArtboard id="m-cram" label="Cram" width={560} height={560}><window.CramModeBoard/></DCArtboard>
      </DCSection>

      <DCSection id="recap" title="Recap & Mastery" subtitle="Every session turns into clarity — and a plan that gets you exam-ready">
        <DCArtboard id="recap-d" label="Session recap" width={1180} height={812}><window.RecapBoard/></DCArtboard>
        <DCArtboard id="map" label="Mastery map" width={720} height={620}><window.MasteryMapBoard/></DCArtboard>
        <DCArtboard id="recap-m" label="Recap · mobile" width={390} height={860}><window.RecapMobileBoard/></DCArtboard>
      </DCSection>

      <DCSection id="library" title="Library" subtitle="Study sets, not a file manager — no folders, tables, or filters">
        <DCArtboard id="lib-d" label="Library · desktop" width={1180} height={760}><window.LibraryBoard/></DCArtboard>
        <DCArtboard id="lib-m" label="Library · mobile" width={390} height={820}><window.LibraryMobileBoard/></DCArtboard>
      </DCSection>

      <DCSection id="interaction" title="Interaction Model" subtitle="How the generative UI decides what to show, moment to moment">
        <DCArtboard id="ix" label="Generative UI loop" width={960} height={520}><InteractionBoard/></DCArtboard>
      </DCSection>
    </DesignCanvas>
  );
}
ReactDOM.createRoot(document.getElementById('root')).render(<App/>);
