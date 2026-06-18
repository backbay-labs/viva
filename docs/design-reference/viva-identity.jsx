// viva-identity.jsx — visual identity + component system boards
const { VoiceOrb, Wordmark, Spark, Sprig, Icon, Equalizer, ContextPill, ModeChip,
  SourceChip, MasteryChip, MasteryRing, ActionCard, TimelineItem, MobileButton,
  Avatar, FeedbackCard } = window;

const Fill = ({bg='var(--bg)', pad=0, children, style}) => (
  <div className="v-root" style={{width:'100%',height:'100%',background:bg,padding:pad,overflow:'hidden',...style}}>{children}</div>
);

/* ── Wordmark / logo lockup ── */
function WordmarkBoard() {
  return (
    <Fill bg="var(--bg)" style={{display:'flex',flexDirection:'column',justifyContent:'space-between',padding:'46px 44px'}}>
      <div>
        <div style={{position:'relative',display:'inline-flex',alignItems:'flex-start'}}>
          <span className="serif" style={{fontSize:96,fontWeight:600,letterSpacing:'.005em',color:'var(--ink)',lineHeight:.84}}>Viva</span>
          <Spark size={30} color="var(--plum)" style={{position:'absolute',top:2,right:-22}}/>
          <Spark size={13} color="var(--gold)" style={{position:'absolute',top:30,right:-30}}/>
        </div>
        <div className="kicker" style={{marginTop:20,fontSize:12.5}}>Voice-first AI study companion</div>
      </div>
      <div style={{display:'flex',alignItems:'flex-end',justifyContent:'space-between',gap:20}}>
        <p className="serif" style={{fontSize:22,fontWeight:500,fontStyle:'italic',color:'var(--ink-2)',lineHeight:1.3,maxWidth:300,margin:0}}>
          “Study by talking, not rereading.”
        </p>
        <Sprig w={120} color="var(--gold)" style={{flex:'none',opacity:.55}}/>
      </div>
    </Fill>
  );
}

/* ── Typography ── */
function TypeBoard() {
  const Row = ({tag, children, note}) => (
    <div style={{display:'flex',alignItems:'baseline',gap:16,paddingBottom:16,borderBottom:'1px solid var(--line-soft)'}}>
      <span className="kicker" style={{width:64,flex:'none',fontSize:9.5}}>{tag}</span>
      <div style={{flex:1}}>{children}</div>
      {note&&<span className="cap" style={{fontSize:11,flex:'none'}}>{note}</span>}
    </div>
  );
  return (
    <Fill bg="var(--paper)" style={{padding:'40px 42px',display:'flex',flexDirection:'column',gap:18}}>
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'baseline'}}>
        <span className="kicker">Typography</span>
        <span className="cap">Cormorant · Hanken Grotesk</span>
      </div>
      <Row tag="Display" note="Cormorant 600">
        <div className="serif" style={{fontSize:46,fontWeight:600,lineHeight:.98,color:'var(--ink)',letterSpacing:'-.015em'}}>Talk your way<br/>to mastery</div>
      </Row>
      <Row tag="Emotional" note="Cormorant italic">
        <div className="serif" style={{fontSize:27,fontStyle:'italic',fontWeight:500,color:'var(--plum-deep)'}}>“You’re close. Try again with an example.”</div>
      </Row>
      <Row tag="Heading" note="Hanken 600">
        <div style={{fontSize:20,fontWeight:600,color:'var(--ink)'}}>Session recap</div>
      </Row>
      <Row tag="Body" note="Hanken 400">
        <div style={{fontSize:15,color:'var(--ink-2)',lineHeight:1.5,maxWidth:380}}>Viva quizzes you out loud, listens to your explanations, and pushes back until you actually know it.</div>
      </Row>
      <Row tag="Label" note="Hanken 600 · .14em">
        <div className="kicker" style={{fontSize:12}}>Start 10-minute recall drill</div>
      </Row>
      <div style={{display:'flex',alignItems:'baseline',gap:16}}>
        <span className="kicker" style={{width:64,flex:'none',fontSize:9.5}}>Numeric</span>
        <div style={{display:'flex',gap:24,alignItems:'baseline'}}>
          <span className="serif" style={{fontSize:40,fontWeight:600,color:'var(--ink)',fontVariantNumeric:'tabular-nums'}}>07:32</span>
          <span style={{fontSize:30,fontWeight:600,color:'var(--sage)'}}>72%</span>
        </div>
      </div>
    </Fill>
  );
}

/* ── Palette ── */
function PaletteBoard() {
  const Sw = ({c, name, hex, dark}) => (
    <div style={{flex:1}}>
      <div style={{height:60,borderRadius:12,background:c,border:'1px solid var(--line)',boxShadow:'inset 0 0 0 1px rgba(255,255,255,.25)'}}/>
      <div style={{marginTop:7,fontSize:12,fontWeight:600,color:'var(--ink)'}}>{name}</div>
      <div style={{fontSize:11,color:'var(--ink-3)',fontVariantNumeric:'tabular-nums'}}>{hex}</div>
    </div>
  );
  const Grp = ({label, children}) => (
    <div>
      <div className="kicker" style={{fontSize:9.5,marginBottom:11}}>{label}</div>
      <div style={{display:'flex',gap:12}}>{children}</div>
    </div>
  );
  return (
    <Fill bg="var(--paper)" style={{padding:'40px 42px',display:'flex',flexDirection:'column',gap:24}}>
      <span className="kicker">Color</span>
      <Grp label="Surfaces">
        <Sw c="#f4efe6" name="Parchment" hex="#F4EFE6"/>
        <Sw c="#efe8dc" name="Backdrop" hex="#EFE8DC"/>
        <Sw c="#faf7f1" name="Paper" hex="#FAF7F1"/>
      </Grp>
      <Grp label="Ink">
        <Sw c="#2c2536" name="Ink" hex="#2C2536"/>
        <Sw c="#5d5670" name="Ink 2" hex="#5D5670"/>
        <Sw c="#938aa4" name="Ink 3" hex="#938AA4"/>
      </Grp>
      <Grp label="Accent — amethyst">
        <Sw c="#553b78" name="Deep" hex="#553B78"/>
        <Sw c="#7a5ba6" name="Plum" hex="#7A5BA6"/>
        <Sw c="#a98fce" name="Soft" hex="#A98FCE"/>
        <Sw c="#efe7f6" name="Wash" hex="#EFE7F6"/>
      </Grp>
      <Grp label="Micro accents">
        <Sw c="#7f9277" name="Sage" hex="#7F9277"/>
        <Sw c="#bd9a55" name="Gold" hex="#BD9A55"/>
        <Sw c="#c1864a" name="Amber" hex="#C1864A"/>
        <Sw c="#c3b2dd" name="Lavender" hex="#C3B2DD"/>
      </Grp>
    </Fill>
  );
}

/* ── Voice orb states ── */
function OrbStatesBoard() {
  const states = [
    {s:'ready',name:'Ready',d:'Calm breathing idle. Waiting for you to begin.'},
    {s:'listening',name:'Listening',d:'Brightens and quickens to your voice.',wave:true},
    {s:'thinking',name:'Thinking',d:'Inward shimmer, a single orbiting thought.'},
    {s:'correcting',name:'Correcting',d:'Warm gold halo — supportive, never punitive.'},
    {s:'encouraging',name:'Encouraging',d:'A soft sage bloom of momentum.'},
    {s:'recall',name:'Deep recall',d:'Denser, focused — mock-viva intensity.'},
  ];
  return (
    <Fill bg="var(--bg)" style={{padding:'38px 40px',display:'flex',flexDirection:'column',gap:26}}>
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'baseline'}}>
        <span className="kicker">Voice orb · states</span>
        <span className="cap">The emotional + functional center of Viva</span>
      </div>
      <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:'30px 26px'}}>
        {states.map(st=>(
          <div key={st.s} style={{display:'flex',flexDirection:'column',alignItems:'center',gap:12,textAlign:'center'}}>
            <div style={{height:118,display:'grid',placeItems:'center'}}>
              <VoiceOrb size={104} state={st.s}/>
            </div>
            {st.wave?<Equalizer bars={9}/>:<div style={{height:22}}/>}
            <div>
              <div style={{fontSize:14.5,fontWeight:600,color:'var(--ink)'}}>{st.name}</div>
              <div className="cap" style={{fontSize:11.5,marginTop:3,maxWidth:200,lineHeight:1.35}}>{st.d}</div>
            </div>
          </div>
        ))}
      </div>
    </Fill>
  );
}

/* ── Component catalog ── */
function ComponentsBoard() {
  const Cell = ({label, children, span}) => (
    <div style={{gridColumn:span?'span '+span:'auto'}}>
      <div className="kicker" style={{fontSize:9,marginBottom:10}}>{label}</div>
      <div style={{display:'flex',flexWrap:'wrap',gap:9,alignItems:'center'}}>{children}</div>
    </div>
  );
  return (
    <Fill bg="var(--paper)" style={{padding:'38px 40px',display:'flex',flexDirection:'column',gap:22}}>
      <span className="kicker">Component system</span>
      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:'22px 30px'}}>
        <Cell label="Context pill" span={2}><ContextPill/></Cell>
        <Cell label="Mode chips" span={2}>
          <ModeChip mode="quiz" label="Quiz me" active/>
          <ModeChip mode="teach" label="Teach me"/>
          <ModeChip mode="mock" label="Mock viva"/>
          <ModeChip mode="cram" label="Cram"/>
        </Cell>
        <Cell label="Source citation"><SourceChip/></Cell>
        <Cell label="Mastery chips">
          <MasteryChip tier="strong" label="Strong" pct={72}/>
          <MasteryChip tier="shaky" label="Shaky" pct={18}/>
          <MasteryChip tier="review" label="Review" pct={10}/>
        </Cell>
        <Cell label="Mastery ring"><MasteryRing pct={72} size={76} label="strong"/></Cell>
        <Cell label="Mobile action"><div style={{width:180}}><MobileButton icon="bulb" label="Need a hint?"/></div></Cell>
        <Cell label="Generated card">
          <div style={{width:210}}><ActionCard icon="bolt" kicker="Start" title="10-minute recall drill" sub="Highest-yield weak areas" primary/></div>
        </Cell>
        <Cell label="Feedback action">
          <div style={{width:230}}><FeedbackCard icon="pen" title="Try again with an example" sub="Explain using the shuttle systems"/></div>
        </Cell>
      </div>
    </Fill>
  );
}

Object.assign(window, { WordmarkBoard, TypeBoard, PaletteBoard, OrbStatesBoard, ComponentsBoard });
