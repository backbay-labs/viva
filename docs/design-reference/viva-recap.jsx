// viva-recap.jsx — session recap + mastery map (desktop + mobile)
const { F } = window;
const { VoiceOrb, Spark, Icon, MasteryRing, MasteryChip, SourceChip, TimelineItem } = window;

function StatCard({tier='strong', label, pct, topics, color}) {
  return (
    <div className="v-soft-card" style={{padding:'20px 22px',display:'flex',alignItems:'center',gap:18}}>
      <MasteryRing pct={pct} size={86} color={color}/>
      <div>
        <div style={{fontSize:14.5,fontWeight:700,color,marginBottom:4}}>{label}</div>
        <div className="serif" style={{fontSize:30,fontWeight:600,color:'var(--ink)',lineHeight:1}}>{topics}<span style={{fontSize:15,color:'var(--ink-3)',fontFamily:'var(--sans)',fontWeight:500}}> topics</span></div>
      </div>
    </div>
  );
}

function Moment({text, src, tone='shaky'}) {
  const c={shaky:'var(--amber)',strong:'var(--sage)',review:'var(--plum)'}[tone];
  return (
    <div style={{display:'flex',gap:12,paddingBottom:14,borderBottom:'1px solid var(--line-soft)'}}>
      <span style={{width:6,borderRadius:3,background:c,flex:'none',marginTop:2}}/>
      <div style={{flex:1}}>
        <div style={{fontSize:13.5,color:'var(--ink-2)',lineHeight:1.4}}>{text}</div>
        <div style={{marginTop:7}}><SourceChip label={src} tone="plum"/></div>
      </div>
    </div>
  );
}

/* ── Recap desktop ── */
function RecapBoard() {
  return (
    <F style={{display:'flex',flexDirection:'column',padding:'26px 40px 30px'}}>
      <div style={{display:'flex',alignItems:'center',justifyContent:'space-between'}}>
        <div className="chip" style={{gap:9,fontSize:14,color:'var(--ink-2)',fontWeight:500}}>
          <Icon name="cal" size={16} color="var(--plum)"/> <span style={{fontWeight:600,color:'var(--ink)'}}>Session recap</span>
          <span style={{color:'var(--ink-4)'}}>·</span> 14 May · 45 min
        </div>
        <button className="chip" style={{background:'var(--paper-2)',border:'1px solid var(--line)',padding:'8px 15px',fontSize:13,fontWeight:600,color:'var(--ink)',cursor:'pointer',gap:7}}><Icon name="share" size={15} color="var(--plum)"/> Share</button>
      </div>

      <div style={{textAlign:'center',margin:'14px 0 24px'}}>
        <div style={{display:'flex',justifyContent:'center',marginBottom:12}}><VoiceOrb size={56} state="encouraging"/></div>
        <h1 className="display" style={{fontSize:44,margin:0}}>Good session, Ananya.</h1>
        <p style={{fontSize:16,color:'var(--ink-2)',margin:'8px 0 0'}}>You’re building real understanding — and we found exactly what to revisit.</p>
      </div>

      <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:16,marginBottom:22}}>
        <StatCard label="Strong" pct={72} topics={12} color="var(--sage)"/>
        <StatCard label="Shaky" pct={18} topics={3} color="var(--amber)"/>
        <StatCard label="Review tomorrow" pct={10} topics={2} color="var(--plum)"/>
      </div>

      <div style={{display:'grid',gridTemplateColumns:'1fr 360px',gap:24,flex:1,minHeight:0}}>
        {/* study plan */}
        <div className="v-soft-card" style={{padding:'22px 26px'}}>
          <div className="kicker" style={{fontSize:10,marginBottom:18}}>Your generated study plan</div>
          <TimelineItem status="done" day="Today" topics="Cellular respiration · Photosynthesis · Enzymes" meta="Completed"/>
          <TimelineItem status="today" day="Tomorrow · 15 min" topics="Genetic code · Transcription" meta="Scheduled"/>
          <TimelineItem status="upcoming" day="Fri 16 May · 15 min" topics="Cell cycle · Mitosis" meta="Pre-exam" last/>
        </div>
        {/* moments */}
        <div className="v-soft-card" style={{padding:'22px 24px',background:'var(--paper-2)'}}>
          <div className="kicker" style={{fontSize:10,marginBottom:16,display:'flex',alignItems:'center',gap:7}}><Spark size={13} color="var(--plum)"/> Moments worth revisiting</div>
          <div style={{display:'flex',flexDirection:'column',gap:14}}>
            <Moment tone="shaky" text="ATP yield — you said 36, it’s 30–32 for this course." src="Lecture 5 · slide 12"/>
            <Moment tone="shaky" text="Skipped the mechanism of the proton gradient." src="Lecture 5 · slide 18"/>
          </div>
        </div>
      </div>

      <div style={{display:'flex',gap:12,marginTop:22}}>
        <button className="chip" style={{flex:1,justifyContent:'center',background:'var(--ink)',color:'#fff',border:'none',padding:'15px',fontSize:15,fontWeight:600,cursor:'pointer',gap:9}}><Icon name="cal" size={17} color="var(--plum-soft)"/> Schedule tomorrow’s recall drill</button>
        <button className="chip" style={{justifyContent:'center',background:'var(--paper-2)',color:'var(--ink)',border:'1px solid var(--line)',padding:'15px 22px',fontSize:14.5,fontWeight:600,cursor:'pointer',gap:9}}><Icon name="mic" size={16} color="var(--plum)"/> Another 5-min drill</button>
      </div>
    </F>
  );
}

/* ── Mastery map ── */
function MasteryMapBoard() {
  const nodes=[
    // respiration cluster (left)
    {x:20,y:32,t:'strong',l:'Glycolysis',r:17},
    {x:13,y:54,t:'shaky',l:'Krebs cycle',r:15},
    {x:27,y:68,t:'review',l:'ATP yield',r:13},
    {x:31,y:46,t:'shaky',l:'NADH',r:12},
    // photosynthesis cluster (mid-top)
    {x:54,y:24,t:'strong',l:'Photosynthesis',r:19},
    {x:64,y:40,t:'strong',l:'Light reactions',r:14},
    {x:48,y:42,t:'strong',l:'Calvin cycle',r:13},
    // genetics cluster (right)
    {x:80,y:58,t:'review',l:'Transcription',r:14},
    {x:88,y:38,t:'strong',l:'Genetic code',r:13},
    {x:74,y:74,t:'shaky',l:'Mitosis',r:12},
  ];
  const edges=[[0,1],[1,2],[0,3],[3,1],[4,5],[4,6],[7,8],[7,9],[3,4]];
  const col={strong:'var(--sage)',shaky:'var(--amber)',review:'var(--plum)'};
  return (
    <F style={{display:'flex',flexDirection:'column',padding:'34px 36px'}}>
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'baseline',marginBottom:6}}>
        <span className="kicker">Mastery map</span>
        <span className="cap" style={{fontSize:11.5}}>Forms gradually, stays minimal</span>
      </div>
      <div style={{flex:1,position:'relative'}}>
        <svg style={{position:'absolute',inset:0,width:'100%',height:'100%'}}>
          {edges.map(([a,b],i)=>(
            <line key={i} x1={nodes[a].x+'%'} y1={nodes[a].y+'%'} x2={nodes[b].x+'%'} y2={nodes[b].y+'%'}
              stroke="rgba(44,37,54,.13)" strokeWidth="1"/>
          ))}
        </svg>
        {nodes.map((n,i)=>(
          <div key={i} style={{position:'absolute',left:n.x+'%',top:n.y+'%',transform:'translate(-50%,-50%)',
            display:'flex',flexDirection:'column',alignItems:'center',gap:6}}>
            <span style={{width:n.r*2,height:n.r*2,borderRadius:'50%',
              background:n.t==='strong'?col[n.t]:'transparent',
              border:'2px solid '+col[n.t],
              boxShadow:n.t==='strong'?'0 3px 12px '+col[n.t]+'44':'none',
              display:'grid',placeItems:'center'}}>
              {n.t==='strong'&&<Spark size={n.r} color="#fff"/>}
            </span>
            <span style={{fontSize:11,fontWeight:600,color:'var(--ink-2)',whiteSpace:'nowrap'}}>{n.l}</span>
          </div>
        ))}
      </div>
      <div style={{display:'flex',gap:16,justifyContent:'center',marginTop:8}}>
        <MasteryChip tier="strong" label="Strong"/>
        <MasteryChip tier="shaky" label="Shaky"/>
        <MasteryChip tier="review" label="Needs review"/>
      </div>
    </F>
  );
}

/* ── Recap mobile ── */
function RecapMobileBoard() {
  return (
    <F style={{display:'flex',flexDirection:'column',padding:'48px 18px 24px'}}>
      <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:18}}>
        <Icon name="x" size={19} color="var(--ink-2)"/>
        <span style={{fontSize:13.5,fontWeight:600,color:'var(--ink)'}}>Session recap</span>
        <Icon name="share" size={17} color="var(--ink-2)"/>
      </div>
      <div style={{textAlign:'center',marginBottom:18}}>
        <div style={{display:'flex',justifyContent:'center',marginBottom:10}}><VoiceOrb size={52} state="encouraging"/></div>
        <h1 className="display" style={{fontSize:30,margin:0}}>Good session,<br/>Ananya.</h1>
        <p style={{fontSize:13.5,color:'var(--ink-2)',margin:'8px 12px 0'}}>You’re building real understanding.</p>
      </div>
      <div style={{display:'flex',gap:10,marginBottom:18}}>
        {[['Strong',72,'var(--sage)'],['Shaky',18,'var(--amber)'],['Review',10,'var(--plum)']].map(([l,p,c])=>(
          <div key={l} className="v-soft-card" style={{flex:1,padding:'14px 8px',display:'flex',flexDirection:'column',alignItems:'center',gap:8}}>
            <MasteryRing pct={p} size={58} stroke={6} color={c}/>
            <span style={{fontSize:11.5,fontWeight:600,color:c}}>{l}</span>
          </div>
        ))}
      </div>
      <div className="v-soft-card" style={{padding:'18px 20px',marginBottom:'auto'}}>
        <div className="kicker" style={{fontSize:9.5,marginBottom:14}}>Study plan</div>
        <TimelineItem status="done" day="Today" topics="Respiration · Enzymes" meta="Done"/>
        <TimelineItem status="today" day="Tomorrow" topics="Genetic code" meta="15 min"/>
        <TimelineItem status="upcoming" day="Fri 16" topics="Cell cycle" meta="15 min" last/>
      </div>
      <button className="chip" style={{width:'100%',justifyContent:'center',background:'var(--ink)',color:'#fff',border:'none',padding:'14px',fontSize:14.5,fontWeight:600,cursor:'pointer',gap:9,marginTop:16}}><Icon name="cal" size={16} color="var(--plum-soft)"/> Schedule tomorrow’s drill</button>
    </F>
  );
}

Object.assign(window, { RecapBoard, MasteryMapBoard, RecapMobileBoard });
