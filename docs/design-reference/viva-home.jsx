// viva-home.jsx — generative home (desktop + mobile) + shared desktop shell
const { F } = window;
const { VoiceOrb, Wordmark, Spark, Sprig, Icon, Equalizer, ContextPill, ModeChip,
  SourceChip, MasteryChip, MasteryRing, ActionCard, Avatar } = window;

/* ── shared left nav rail ── */
function NavRail({active='Today'}) {
  const items=[['Today','home'],['Library','book'],['Sessions','bars']];
  return (
    <div style={{width:212,flex:'none',background:'var(--paper)',borderRight:'1px solid var(--line)',
      padding:'26px 18px',display:'flex',flexDirection:'column'}}>
      <div style={{padding:'0 8px 26px'}}><Wordmark size={27}/></div>
      <div style={{display:'flex',flexDirection:'column',gap:3}}>
        {items.map(([l,ic])=>{
          const on=l===active;
          return (
            <div key={l} className="chip" style={{justifyContent:'flex-start',gap:12,padding:'10px 13px',fontSize:14.5,fontWeight:on?600:500,
              color:on?'var(--ink)':'var(--ink-2)',background:on?'var(--plum-wash)':'transparent',
              border:'1px solid '+(on?'var(--plum-line)':'transparent'),cursor:'pointer'}}>
              <Icon name={ic} size={18} color={on?'var(--plum)':'var(--ink-3)'}/>{l}
            </div>
          );
        })}
      </div>
      <div style={{flex:1}}/>
      <div className="v-soft-card" style={{padding:'14px',background:'var(--bg)',borderRadius:14}}>
        <div className="kicker" style={{fontSize:9,marginBottom:7}}>Next review</div>
        <div style={{fontSize:13.5,fontWeight:600,color:'var(--ink)'}}>Tomorrow · 8 min</div>
        <div style={{fontSize:12,color:'var(--ink-3)',marginTop:2}}>NADH, Krebs cycle</div>
      </div>
      <div style={{display:'flex',alignItems:'center',gap:11,padding:'16px 8px 2px'}}>
        <Avatar size={32} initial="A"/>
        <div style={{flex:1,minWidth:0}}>
          <div style={{fontSize:13,fontWeight:600,color:'var(--ink)'}}>Ananya</div>
          <div style={{fontSize:11,color:'var(--ink-3)'}}>Free plan</div>
        </div>
        <Icon name="sliders" size={17} color="var(--ink-3)"/>
      </div>
    </div>
  );
}

/* weak-concept chip orbiting the orb */
function OrbitChip({label, tier='review', style}) {
  const c={review:'var(--plum)',shaky:'var(--amber)',strong:'var(--sage)'}[tier];
  return (
    <div className="orbit-chip chip" style={{background:'var(--paper-2)',border:'1px solid var(--line)',
      padding:'7px 13px',fontSize:12.5,fontWeight:600,color:'var(--ink-2)',boxShadow:'var(--shadow-sm)',...style}}>
      <span style={{width:7,height:7,borderRadius:'50%',background:c}}/>{label}
    </div>
  );
}

/* ── Desktop home ── */
function HomeBoard() {
  return (
    <F style={{display:'flex'}}>
      <NavRail active="Today"/>
      <div style={{flex:1,display:'flex',flexDirection:'column',padding:'24px 40px 30px',position:'relative'}}>
        {/* top bar */}
        <div style={{display:'flex',alignItems:'center',justifyContent:'space-between'}}>
          <div>
            <div className="kicker" style={{fontSize:10}}>Thursday · 14 May</div>
            <div style={{fontSize:15,color:'var(--ink-2)',marginTop:3}}>Good evening, Ananya</div>
          </div>
          <div style={{display:'flex',alignItems:'center',gap:12}}>
            <button className="chip" style={{background:'var(--paper-2)',border:'1px solid var(--line)',padding:'9px 15px',
              fontSize:13.5,fontWeight:600,color:'var(--ink)',cursor:'pointer'}}><Icon name="upload" size={15} color="var(--plum)"/> Upload</button>
          </div>
        </div>

        {/* hero */}
        <div style={{flex:1,display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',gap:0}}>
          <ContextPill/>
          <h1 className="display" style={{fontSize:50,textAlign:'center',margin:'16px 0 0'}}>Talk your way to mastery</h1>

          <div style={{position:'relative',width:420,height:236,display:'grid',placeItems:'center',margin:'4px 0'}}>
            <VoiceOrb size={156} state="ready"/>
            <OrbitChip label="Cellular respiration" tier="shaky" style={{top:14,left:6,animationDelay:'-1s'}}/>
            <OrbitChip label="Krebs cycle" tier="review" style={{top:30,right:0,animationDelay:'-2.4s'}}/>
            <OrbitChip label="NADH" tier="review" style={{bottom:24,left:30,animationDelay:'-3.1s'}}/>
            <OrbitChip label="Photosynthesis" tier="strong" style={{bottom:8,right:34,animationDelay:'-0.6s'}}/>
          </div>

          <button className="chip" style={{background:'var(--ink)',color:'#fff',border:'none',padding:'15px 30px',
            fontSize:15.5,fontWeight:600,cursor:'pointer',boxShadow:'var(--shadow-md)',gap:11}}>
            <Icon name="mic" size={18} color="var(--plum-soft)"/> Start 10-minute recall drill
          </button>
          <div style={{display:'flex',gap:9,marginTop:18}}>
            <ModeChip mode="quiz" label="Quiz me" active/>
            <ModeChip mode="teach" label="Teach me"/>
            <ModeChip mode="mock" label="Mock viva"/>
            <ModeChip mode="cram" label="Cram"/>
          </div>
        </div>

        {/* generated cards */}
        <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:16}}>
          <ActionCard icon="target" kicker="Weak concept" title="Cellular respiration" sub="You missed this twice — let’s close the gap." accent="amber"/>
          <ActionCard icon="bars" kicker="Next best session" title="Lecture 5 recall" sub="Electron transport · 10 min" accent="plum"/>
          <div className="v-soft-card" style={{padding:'20px 22px',display:'flex',alignItems:'center',gap:16}}>
            <MasteryRing pct={72} size={74} color="var(--sage)"/>
            <div>
              <div className="kicker" style={{fontSize:10,marginBottom:5}}>Mastery</div>
              <div className="serif" style={{fontSize:21,fontWeight:600,lineHeight:1.1,color:'var(--ink)'}}>Strong on<br/>Photosynthesis</div>
            </div>
          </div>
        </div>
      </div>
    </F>
  );
}

/* ── Desktop home · regenerated for exam proximity ── */
function HomeExamBoard() {
  return (
    <F bg="var(--bg-deep)" style={{display:'flex'}}>
      <NavRail active="Today"/>
      <div style={{flex:1,display:'flex',flexDirection:'column',padding:'24px 40px 30px',position:'relative'}}>
        <div style={{display:'flex',alignItems:'center',justifyContent:'space-between'}}>
          <div>
            <div className="kicker" style={{fontSize:10,color:'var(--amber)'}}>Wednesday · 1 day to exam</div>
            <div style={{fontSize:15,color:'var(--ink-2)',marginTop:3}}>Let’s make today count, Ananya</div>
          </div>
          <button className="chip" style={{background:'var(--paper-2)',border:'1px solid var(--line)',padding:'9px 15px',
            fontSize:13.5,fontWeight:600,color:'var(--ink)',cursor:'pointer'}}><Icon name="upload" size={15} color="var(--plum)"/> Upload</button>
        </div>

        <div style={{flex:1,display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center'}}>
          <span className="chip" style={{background:'var(--amber-wash)',color:'var(--amber)',border:'1px solid var(--amber)22',
            padding:'7px 15px',fontSize:13,fontWeight:600}}><Icon name="bolt" size={14} color="var(--amber)" fill/> Exam tomorrow · prioritizing Lectures 4–6</span>
          <h1 className="display" style={{fontSize:50,textAlign:'center',margin:'16px 0 0'}}>You don’t need more notes.<br/>You need retrieval.</h1>

          <div style={{position:'relative',width:420,height:222,display:'grid',placeItems:'center',margin:'2px 0'}}>
            <VoiceOrb size={150} state="recall"/>
            <OrbitChip label="ATP yield" tier="shaky" style={{top:18,left:18,animationDelay:'-1s'}}/>
            <OrbitChip label="Shuttle systems" tier="shaky" style={{top:34,right:6,animationDelay:'-2.4s'}}/>
            <OrbitChip label="Krebs cycle" tier="review" style={{bottom:20,left:40,animationDelay:'-3.1s'}}/>
          </div>

          <button className="chip" style={{background:'var(--ink)',color:'#fff',border:'none',padding:'15px 30px',
            fontSize:15.5,fontWeight:600,cursor:'pointer',boxShadow:'var(--shadow-md)',gap:11}}>
            <Icon name="bolt" size={18} color="var(--plum-soft)" fill/> Start 15-min cram · weak areas
          </button>
        </div>

        <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:16}}>
          <ActionCard icon="bolt" kicker="Highest yield" title="ATP yield & shuttles" sub="Missed in your last 2 sessions." accent="amber"/>
          <ActionCard icon="cap" kicker="Quick reteach" title="Krebs cycle, in 3 min" sub="Teach-me mode" accent="plum"/>
          <ActionCard icon="cal" kicker="Tonight" title="One last mock viva" sub="20 min · exam conditions" accent="gold"/>
        </div>
      </div>
    </F>
  );
}

/* ── Mobile home ── */
function HomeMobileBoard() {
  return (
    <F style={{display:'flex',flexDirection:'column',padding:'52px 18px 24px'}}>
      <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:18}}>
        <Icon name="menu" size={20} color="var(--ink-2)"/>
        <Wordmark size={22}/>
        <Icon name="sliders" size={19} color="var(--ink-2)"/>
      </div>
      <div style={{display:'flex',justifyContent:'center',marginBottom:14}}><ContextPill items={['Biology Midterm','Exam Fri']} small/></div>
      <h1 className="display" style={{fontSize:33,textAlign:'center',margin:'2px 0 0',lineHeight:1.04}}>Talk your way<br/>to mastery</h1>

      <div style={{position:'relative',height:200,display:'grid',placeItems:'center',margin:'6px 0 4px'}}>
        <VoiceOrb size={140} state="ready"/>
        <OrbitChip label="Cellular respiration" tier="shaky" style={{top:8,left:0,animationDelay:'-1s',fontSize:11.5,padding:'6px 11px'}}/>
        <OrbitChip label="NADH" tier="review" style={{bottom:18,right:8,animationDelay:'-2.6s',fontSize:11.5,padding:'6px 11px'}}/>
      </div>

      <button className="chip" style={{justifyContent:'center',width:'100%',background:'var(--ink)',color:'#fff',border:'none',
        padding:'15px',fontSize:15,fontWeight:600,cursor:'pointer',boxShadow:'var(--shadow-md)',gap:10,marginBottom:14}}>
        <Icon name="mic" size={17} color="var(--plum-soft)"/> Start 10-minute recall drill
      </button>

      <div style={{display:'flex',gap:8,overflow:'hidden',marginBottom:16}}>
        <ModeChip mode="quiz" label="Quiz me" active/>
        <ModeChip mode="teach" label="Teach me"/>
        <ModeChip mode="cram" label="Cram"/>
      </div>

      <ActionCard icon="target" kicker="Weak concept" title="Cellular respiration" sub="You missed this twice." accent="amber" style={{minHeight:0}}/>
    </F>
  );
}

Object.assign(window, { NavRail, OrbitChip, HomeBoard, HomeExamBoard, HomeMobileBoard });
