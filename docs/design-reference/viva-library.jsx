// viva-library.jsx — library / study sets (desktop + mobile)
const { F, NavRail } = window;
const { VoiceOrb, Spark, Icon, Wordmark, MasteryRing, MasteryChip, ContextPill, Avatar } = window;

function MasteryBar({strong=60, shaky=25, height=8}) {
  const review=100-strong-shaky;
  return (
    <div style={{display:'flex',height,borderRadius:height/2,overflow:'hidden',background:'var(--line)'}}>
      <span style={{width:strong+'%',background:'var(--sage)'}}/>
      <span style={{width:shaky+'%',background:'var(--amber)'}}/>
      <span style={{width:review+'%',background:'var(--plum)'}}/>
    </div>
  );
}

function StudySetCard({title, exam, examTone='plum', docs, last, next, strong, shaky, state='ready', compact}) {
  return (
    <div className="v-soft-card" style={{padding:compact?'18px 18px':'22px 24px',display:'flex',flexDirection:'column',gap:compact?13:16,
      boxShadow:'var(--shadow-sm)',borderRadius:'var(--radius)'}}>
      <div style={{display:'flex',alignItems:'flex-start',justifyContent:'space-between',gap:12}}>
        <div style={{flex:1,minWidth:0}}>
          <h3 className="display" style={{fontSize:compact?22:25,margin:0,lineHeight:1.05}}>{title}</h3>
          <div style={{fontSize:12.5,color:'var(--ink-3)',marginTop:5}}>{docs} docs · {last}</div>
        </div>
        <VoiceOrb size={compact?38:44} state={state}/>
      </div>
      <span className="chip" style={{alignSelf:'flex-start',background:examTone==='amber'?'var(--amber-wash)':'var(--paper-2)',
        color:examTone==='amber'?'var(--amber)':'var(--ink-2)',border:'1px solid '+(examTone==='amber'?'var(--amber)33':'var(--line)'),
        padding:'5px 12px',fontSize:12,fontWeight:600}}>
        <Icon name="cal" size={13} color={examTone==='amber'?'var(--amber)':'var(--ink-3)'}/> {exam}
      </span>
      <div>
        <div style={{display:'flex',justifyContent:'space-between',fontSize:11.5,marginBottom:7}}>
          <span style={{color:'var(--ink-3)'}}>Mastery</span>
          <span style={{fontWeight:600,color:'var(--sage)'}}>{strong}% strong</span>
        </div>
        <MasteryBar strong={strong} shaky={shaky}/>
      </div>
      <hr className="thin-divider"/>
      <button className="chip" style={{justifyContent:'space-between',width:'100%',background:'transparent',border:'none',
        padding:0,cursor:'pointer',color:'var(--ink)'}}>
        <span style={{display:'flex',alignItems:'center',gap:9,fontSize:13.5,fontWeight:600}}>
          <Icon name="mic" size={15} color="var(--plum)"/> Next: {next}
        </span>
        <Icon name="arrow" size={16} color="var(--plum)"/>
      </button>
    </div>
  );
}

/* ── Library desktop ── */
function LibraryBoard() {
  return (
    <F style={{display:'flex'}}>
      <NavRail active="Library"/>
      <div style={{flex:1,padding:'30px 40px',display:'flex',flexDirection:'column'}}>
        <div style={{display:'flex',alignItems:'flex-end',justifyContent:'space-between',marginBottom:24}}>
          <div>
            <h1 className="display" style={{fontSize:40,margin:0}}>Library</h1>
            <p style={{fontSize:14.5,color:'var(--ink-3)',margin:'6px 0 0'}}>3 study sets · 1 exam this week</p>
          </div>
          <button className="chip" style={{background:'var(--ink)',color:'#fff',border:'none',padding:'11px 18px',fontSize:14,fontWeight:600,cursor:'pointer',gap:8}}>
            <Icon name="plus" size={16} color="var(--plum-soft)"/> New study set
          </button>
        </div>
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:18}}>
          <StudySetCard title="Biology Midterm" exam="Exam Fri, 16 May" examTone="amber" docs={3} last="Studied 2h ago" next="Lecture 5 recall · 10 min" strong={72} shaky={18} state="recall"/>
          <StudySetCard title="Organic Chemistry" exam="Exam in 2 weeks" docs={5} last="Studied yesterday" next="Reaction mechanisms · 12 min" strong={54} shaky={28} state="ready"/>
          <StudySetCard title="Psychology 101" exam="No exam set" docs={2} last="Studied 4 days ago" next="Memory models · 8 min" strong={81} shaky={11} state="encouraging"/>
          <div style={{border:'1.5px dashed var(--plum-line)',borderRadius:'var(--radius)',display:'flex',flexDirection:'column',
            alignItems:'center',justifyContent:'center',gap:12,color:'var(--ink-3)',background:'var(--paper)',minHeight:230,cursor:'pointer'}}>
            <span style={{width:48,height:48,borderRadius:'50%',display:'grid',placeItems:'center',background:'var(--plum-wash)',border:'1px solid var(--plum-line)'}}>
              <Icon name="upload" size={22} color="var(--plum)"/>
            </span>
            <div style={{textAlign:'center'}}>
              <div style={{fontSize:14.5,fontWeight:600,color:'var(--ink)'}}>Add a study set</div>
              <div style={{fontSize:12.5,color:'var(--ink-3)',marginTop:2}}>Drop notes, slides, or a PDF</div>
            </div>
          </div>
        </div>
      </div>
    </F>
  );
}

/* ── Library mobile ── */
function LibraryMobileBoard() {
  const Tab=({ic,l,on})=>(
    <div style={{flex:1,display:'flex',flexDirection:'column',alignItems:'center',gap:4,color:on?'var(--plum)':'var(--ink-3)'}}>
      <Icon name={ic} size={20} color={on?'var(--plum)':'var(--ink-3)'}/>
      <span style={{fontSize:10.5,fontWeight:on?600:500}}>{l}</span>
    </div>
  );
  return (
    <F style={{display:'flex',flexDirection:'column',padding:'48px 18px 0'}}>
      <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:18}}>
        <h1 className="display" style={{fontSize:30,margin:0}}>Library</h1>
        <span style={{width:38,height:38,borderRadius:'50%',display:'grid',placeItems:'center',background:'var(--plum-wash)',border:'1px solid var(--plum-line)'}}><Icon name="plus" size={18} color="var(--plum)"/></span>
      </div>
      <div style={{display:'flex',flexDirection:'column',gap:13,overflow:'hidden'}}>
        <StudySetCard compact title="Biology Midterm" exam="Exam Fri, 16 May" examTone="amber" docs={3} last="2h ago" next="Lecture 5 · 10 min" strong={72} shaky={18} state="recall"/>
        <StudySetCard compact title="Organic Chemistry" exam="Exam in 2 weeks" docs={5} last="Yesterday" next="Mechanisms · 12 min" strong={54} shaky={28} state="ready"/>
      </div>
      <div style={{flex:1}}/>
      <div style={{display:'flex',padding:'14px 8px 22px',borderTop:'1px solid var(--line)',margin:'14px -18px 0',background:'var(--paper)'}}>
        <Tab ic="home" l="Today"/><Tab ic="book" l="Library" on/><Tab ic="bars" l="Sessions"/>
      </div>
    </F>
  );
}

Object.assign(window, { LibraryBoard, LibraryMobileBoard, StudySetCard, MasteryBar });
