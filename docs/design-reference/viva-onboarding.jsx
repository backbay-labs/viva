// viva-onboarding.jsx — first-run / upload screens
const { Fill } = window;
const { VoiceOrb, Wordmark, Spark, Sprig, Icon, ContextPill, SourceChip } = window;

const F = ({bg='var(--bg)', children, style}) => (
  <div className="v-root" style={{width:'100%',height:'100%',background:bg,overflow:'hidden',position:'relative',...style}}>{children}</div>
);

function Dropzone({compact}) {
  return (
    <div style={{border:'1.5px dashed var(--plum-line)',background:'var(--paper)',borderRadius:'var(--radius-lg)',
      padding:compact?'30px 22px':'44px 40px',textAlign:'center',display:'flex',flexDirection:'column',alignItems:'center',
      gap:compact?12:16,boxShadow:'inset 0 1px 0 rgba(255,255,255,.6)'}}>
      <span style={{width:compact?52:62,height:compact?52:62,borderRadius:'50%',display:'grid',placeItems:'center',
        background:'radial-gradient(circle at 40% 35%,var(--plum-wash),#fff)',border:'1px solid var(--plum-line)'}}>
        <Icon name="upload" size={compact?22:26} color="var(--plum)" sw={1.5}/>
      </span>
      <div>
        <div style={{fontSize:compact?15:16.5,fontWeight:600,color:'var(--ink)'}}>Drop PDFs, slides, or notes</div>
        <div style={{fontSize:compact?12.5:13.5,color:'var(--ink-3)',marginTop:3}}>or <span style={{color:'var(--plum)',fontWeight:600,textDecoration:'underline',textUnderlineOffset:2}}>paste text</span></div>
      </div>
      <div style={{display:'flex',gap:7,flexWrap:'wrap',justifyContent:'center',marginTop:2}}>
        {['PDF','Slides','Notes','Transcript'].map(t=>(
          <span key={t} style={{fontSize:11,fontWeight:600,color:'var(--ink-3)',background:'var(--paper-2)',
            border:'1px solid var(--line)',borderRadius:999,padding:'4px 11px'}}>{t}</span>
        ))}
      </div>
    </div>
  );
}

/* ── Desktop · empty first-run ── */
function UploadEmptyBoard() {
  return (
    <F style={{display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',padding:'40px'}}>
      <div style={{position:'absolute',top:30,left:34}}><Wordmark size={26}/></div>
      <div style={{position:'absolute',top:34,right:34}} className="kicker">New study set</div>
      <Sprig w={150} color="var(--gold)" style={{position:'absolute',bottom:34,right:40,opacity:.4}}/>
      <div style={{width:600,textAlign:'center'}}>
        <div style={{display:'flex',justifyContent:'center',marginBottom:22}}><VoiceOrb size={68} state="ready"/></div>
        <h1 className="display" style={{fontSize:58,margin:0}}>What are we studying?</h1>
        <p style={{fontSize:17,color:'var(--ink-2)',lineHeight:1.5,margin:'16px auto 32px',maxWidth:430}}>
          Drop in your notes. Viva will turn them into a study conversation — so you learn by talking, not rereading.
        </p>
        <Dropzone/>
      </div>
    </F>
  );
}

/* ── Desktop · generated study set ready ── */
function StudySetBoard() {
  const docs=[['Lecture 4 — Glycolysis','24 slides'],['Lecture 5 — The Electron Transport Chain','31 slides'],['Midterm review notes.pdf','9 pages']];
  const topics=['Cellular respiration','Glycolysis','Krebs cycle','Oxidative phosphorylation','Photosynthesis','Enzyme kinetics','ATP yield','Electron transport'];
  return (
    <F style={{display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',padding:'40px'}}>
      <div style={{position:'absolute',top:30,left:34}}><Wordmark size={26}/></div>
      <div style={{position:'absolute',top:34,right:34,display:'flex',alignItems:'center',gap:8}} className="kicker">
        <Icon name="check" size={14} color="var(--sage)" sw={2.2}/> Study set ready
      </div>
      <div style={{width:720,display:'grid',gridTemplateColumns:'1fr 300px',gap:24,alignItems:'start'}}>
        {/* main card */}
        <div className="v-soft-card" style={{padding:'30px 32px',boxShadow:'var(--shadow-lg)',borderRadius:'var(--radius-lg)'}}>
          <div style={{display:'flex',alignItems:'center',gap:14}}>
            <VoiceOrb size={52} state="encouraging"/>
            <div>
              <div className="kicker" style={{fontSize:10}}>Viva read your notes</div>
              <h2 className="display" style={{fontSize:38,margin:'2px 0 0'}}>Biology Midterm</h2>
            </div>
          </div>
          <div style={{display:'flex',gap:8,margin:'18px 0 22px'}}>
            <ContextPill items={['3 documents','Exam Fri, May 16']} small/>
          </div>
          <div className="kicker" style={{fontSize:10,marginBottom:12}}>27 testable concepts found</div>
          <div style={{display:'flex',flexWrap:'wrap',gap:7}}>
            {topics.map(t=>(
              <span key={t} style={{fontSize:12.5,fontWeight:500,color:'var(--ink-2)',background:'var(--paper-2)',
                border:'1px solid var(--line)',borderRadius:999,padding:'6px 13px'}}>{t}</span>
            ))}
            <span style={{fontSize:12.5,fontWeight:600,color:'var(--plum)',padding:'6px 6px'}}>+19 more</span>
          </div>
          <hr className="thin-divider" style={{margin:'24px 0'}}/>
          <div style={{display:'flex',alignItems:'center',gap:12}}>
            <button className="chip" style={{flex:1,justifyContent:'center',background:'var(--ink)',color:'#fff',border:'none',
              padding:'15px',fontSize:15,fontWeight:600,cursor:'pointer',boxShadow:'var(--shadow-md)'}}>
              <Icon name="mic" size={17} color="var(--plum-soft)"/> Start first recall drill
            </button>
            <button className="chip" style={{justifyContent:'center',background:'transparent',color:'var(--ink-2)',
              border:'1px solid var(--line)',padding:'15px 20px',fontSize:14,fontWeight:600,cursor:'pointer'}}>Review set</button>
          </div>
        </div>
        {/* docs side */}
        <div>
          <div className="kicker" style={{fontSize:10,marginBottom:13}}>Documents detected</div>
          <div style={{display:'flex',flexDirection:'column',gap:10}}>
            {docs.map(([n,m],i)=>(
              <div key={i} className="v-soft-card" style={{padding:'13px 14px',display:'flex',gap:11,alignItems:'center'}}>
                <span style={{width:34,height:40,borderRadius:6,flex:'none',background:'var(--plum-wash)',
                  border:'1px solid var(--plum-line)',display:'grid',placeItems:'center'}}>
                  <Icon name="doc" size={16} color="var(--plum)"/>
                </span>
                <div style={{minWidth:0}}>
                  <div style={{fontSize:13,fontWeight:600,color:'var(--ink)',whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'}}>{n}</div>
                  <div style={{fontSize:11.5,color:'var(--ink-3)',marginTop:1}}>{m}</div>
                </div>
              </div>
            ))}
          </div>
          <div style={{marginTop:14,fontSize:12,color:'var(--ink-3)',display:'flex',alignItems:'center',gap:7,padding:'0 4px'}}>
            <Spark size={13} color="var(--gold)"/> Mapped to 27 concepts in 4 seconds
          </div>
        </div>
      </div>
    </F>
  );
}

/* ── Mobile · upload ── */
function UploadMobileBoard() {
  return (
    <F style={{display:'flex',flexDirection:'column',padding:'54px 22px 26px'}}>
      <div style={{display:'flex',justifyContent:'center',marginBottom:26}}><Wordmark size={26}/></div>
      <div style={{display:'flex',justifyContent:'center',marginBottom:18}}><VoiceOrb size={66} state="ready"/></div>
      <h1 className="display" style={{fontSize:38,textAlign:'center',margin:0,lineHeight:1.02}}>What are we<br/>studying?</h1>
      <p style={{fontSize:14.5,color:'var(--ink-2)',textAlign:'center',lineHeight:1.5,margin:'14px 6px 26px'}}>
        Drop in your notes. Viva turns them into a study conversation.
      </p>
      <Dropzone compact/>
      <div style={{flex:1}}/>
      <div style={{textAlign:'center',fontSize:12,color:'var(--ink-3)',display:'flex',alignItems:'center',justifyContent:'center',gap:7}}>
        <Spark size={12} color="var(--gold)"/> No notes yet? Paste a topic instead.
      </div>
    </F>
  );
}

Object.assign(window, { F, UploadEmptyBoard, StudySetBoard, UploadMobileBoard });
