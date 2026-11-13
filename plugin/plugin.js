// Version-bound question replies and readable work cards through the Buzz host.
// Registration lifetimes belong to Cordis; no trial navigation is installed.
export const inject = ['react', 'conversation', 'relay'];
export function apply(ctx) {
  if (!ctx.conversation?.registerMessage)
    throw new Error('Buzz conversation API가 필요합니다.');
  if (ctx.relay?.snapshot && ctx.relay?.subscribe) registerQuestions(ctx);
  registerResourceCards(ctx);
  registerReportCards(ctx);
}

// Protocol v1 uses the host's signed chat outbox, never an administrator token.
export function parseQuestion(message) {
  if (typeof message?.content !== 'string' || message.content.length > 2600) return null;
  const intake = message.content.match(/\n\n\[webling-intake-question:v1:([a-f0-9]{64}):([a-f0-9]{64}):(single|multiple|text)\]$/);
  if (intake && message.content.startsWith('### 답변을 선택해 주세요 · ') && (message.content.match(/\[webling-intake-question:/g)||[]).length===1) {
    const mapped = {...message, content:message.content.slice(0,intake.index)+`\n\n[webling-question:v1:${'0'.repeat(32)}:1:${intake[2]}:${intake[3]}]`};
    const q=parseQuestion(mapped);
    return q ? {...q,kind:'intake',receipt:intake[1]} : null;
  }
  // Previously sent, bounded intake notices have no choices or metadata.
  // Offer free text only; never guess choices from natural language.
  const legacyPrefix='확인이 필요합니다.\n';
  if(message.content.startsWith(legacyPrefix)) {
    const prompt=message.content.slice(legacyPrefix.length);
    if(prompt.trim() && prompt.length<=300 && prompt.split('\n').length<=2 && !/https?:\/\/|@|[\x00-\x08\x0b-\x1f\x7f]/i.test(prompt))
      return {kind:'legacy-intake',id:message.id,mode:'text',title:'요청 내용 확인',prompt,options:[]};
    return null;
  }
  const match = message.content.match(/\n\n\[webling-question:v1:([a-f0-9]{32}):([1-9]\d{0,9}):([a-f0-9]{64}):(single|multiple|text)\]$/);
  if (!match || !message.content.startsWith('### 답변을 선택해 주세요 · ') || (message.content.match(/\[webling-question:/g)||[]).length!==1) return null;
  const body=message.content.slice(0,match.index);
  const block=body.split('\n\n| 항목 |')[0];
  const group=block.match(/(?:^|\n\n)(1\. [^\n]+(?:\n[2-4]\. [^\n]+){1,3})$/);
  const options=group?group[1].split('\n').map((line,i)=>line.startsWith(`${i+1}. `)?line.slice(3):null):[];
  if(options.includes(null)) return null;
  const title=body.split('\n')[0].replace('### 답변을 선택해 주세요 · ','');
  const prompt=block.replace(/^### [^\n]+\n+\*\*진행 내용\*\*\n+/,'').replace(/\n\n1\. [\s\S]*$/,'');
  return {work:match[1],version:Number(match[2]),id:match[3],mode:match[4],body,title,prompt,options:match[4]==='text'?[]:options};
}
export function answerText(question, selected, text) {
  const note=text.trim();
  if(note) {if(note.length>4000 || /[\x00-\x08\x0b-\x1f\x7f]/.test(note)) throw Error('답변은 4,000자 이내로 입력해 주세요.');}
  else if(!selected.length || new Set(selected).size!==selected.length || selected.some(i=>!Number.isInteger(i)||i<0||i>=question.options.length) || (question.mode!=='multiple'&&selected.length!==1)) throw Error('선택하거나 직접 답변을 입력해 주세요.');
  if(question.kind==='legacy-intake') return note;
  const marker=question.kind==='intake' ? `[webling-intake-answer:v1:${question.receipt}:${question.id}]` : `[webling-answer:v1:${question.work}:${question.version}:${question.id}]`;
  return `${marker}\n${note ? 'text:\n'+note : selected.map(i=>i+1).join(',')}`;
}
export function sendAnswer(connection,message,question,selected,text) {
  if(connection.status!=='ready'||!connection.viewer) throw Error('Buzz 연결을 확인해 주세요.');
  if(!/^[a-f0-9]{64}$/.test(message.authorId)||!message.channelId||!/^[a-f0-9]{64}$/.test(message.threadRootId)) throw Error('원래 업무 스레드에서 답해 주세요.');
  // reply() returns an outbox operation ID, not a server acceptance receipt.
  return connection.session.messages.reply(message.channelId,message.threadRootId,
    answerText(question,selected,text),[message.authorId],[],message.id);
}
export function parseAnswer(message) {
  if(typeof message?.content!=='string'||message.content.length>4300)return null;
  const match=message.content.match(/^\[webling-(?:intake-answer:v1:[a-f0-9]{64}:[a-f0-9]{64}|answer:v1:[a-f0-9]{32}:[1-9]\d{0,9}:[a-f0-9]{64})\]\n([\s\S]+)$/);
  if(!match)return null;
  if(match[1].startsWith('text:\n'))return {label:'직접 작성한 답변',text:match[1].slice(6)};
  if(!/^[1-4](?:,[1-4]){0,3}$/.test(match[1]))return null;
  return {label:'선택한 답변',text:match[1].split(',').map(x=>x+'번').join(' · ')};
}
// Return null for keys that belong to the host chat or normal button behavior.
export function radioIndexForKey(key,index,count) {
  if(count<1)return null;
  if(key==='Home')return 0;
  if(key==='End')return count-1;
  if(key==='ArrowRight'||key==='ArrowDown')return (index+1)%count;
  if(key==='ArrowLeft'||key==='ArrowUp')return (index+count-1)%count;
  return null;
}
function registerQuestions(ctx) {
  const R=ctx.react,h=R.createElement;
  // Formatting is created as React elements; message HTML remains literal text.
  function inline(text) {
    return text.split(/(\*\*[^*\n]+\*\*|`[^`\n]+`)/g).map((part,i)=>
      part.startsWith('**')&&part.endsWith('**')?h('strong',{key:i},part.slice(2,-2)):
      part.startsWith('`')&&part.endsWith('`')?h('code',{key:i},part.slice(1,-1)):part);
  }
  function promptBlocks(text) {
    return text.split(/\n\s*\n/).map((part,i)=>{
      const lines=part.split('\n');
      return lines.every(line=>/^[-*] /.test(line))
        ?h('ul',{key:i},...lines.map((line,j)=>h('li',{key:j},...inline(line.slice(2)))))
        :h('p',{key:i,style:{margin:'0 0 8px',whiteSpace:'pre-wrap'}},...inline(part));
    });
  }
  function QuestionForm({message,connection}) {
    const q=parseQuestion(message),[selected,setSelected]=R.useState([]),[note,setNote]=R.useState(''),[sent,setSent]=R.useState(''),[error,setError]=R.useState('');
    const [custom,setCustom]=R.useState(!q.options.length),[focus,setFocus]=R.useState('');
    const submitting=R.useRef(false),optionRefs=R.useRef([]);
    const muted='#526174';
    const line='#c4cddb';
    const wash='#f0f4f8';
    const accent='#174ea6',accentTint='#edf4ff';
    const statusColor=error?'#9b2635':sent?'#174780':'#77420b';
    const statusBackground=error?'#fff0f2':sent?accentTint:'#fff4d6';
    const ready=connection.status==='ready' && (custom ? !!note.trim() : selected.length>0);
    const resetButton={appearance:'none',WebkitAppearance:'none',boxSizing:'border-box',font:'inherit',color:'inherit',margin:0,textTransform:'none',letterSpacing:'normal',cursor:'pointer'};
    function submit(e){e.preventDefault();if(submitting.current)return;submitting.current=true;
      try {if(ctx.relay.snapshot()!==connection)throw Error('연결 상태가 바뀌었습니다. 다시 확인해 주세요.');sendAnswer(connection,message,q,custom?[]:selected,custom?note:'');setSent(custom?note.trim():selected.map(i=>q.options[i]).join(' · '));setError('');}
      catch(err){submitting.current=false;setError(err.message||'답변을 보낼 수 없습니다.');}}
    function navigateChoice(e,index) {
      if(q.mode==='multiple'||e.altKey||e.ctrlKey||e.metaKey||e.shiftKey)return;
      const next=radioIndexForKey(e.key,index,q.options.length);
      if(next===null)return;
      e.preventDefault();e.stopPropagation();setSelected([next]);optionRefs.current[next]?.focus();
    }
    const option=(label,key,active,choose,role,index)=>h('button',{key,type:'button',role,'aria-checked':active,
      ref:node=>{optionRefs.current[index]=node;},
      tabIndex:role==='radio'?(selected.length?active?0:-1:index===0?0:-1):0,
      onKeyDown:e=>navigateChoice(e,index),
      onClick:choose,onFocus:()=>setFocus(key),onBlur:()=>setFocus(''),
      style:{...resetButton,display:'flex',alignItems:'flex-start',gap:10,width:'100%',minHeight:46,padding:'11px 12px',textAlign:'left',border:'1px solid '+(active?accent:line),borderRadius:10,background:active?accentTint:'#ffffff',color:active?'#123d82':'#203247',fontWeight:active?600:400,outline:focus===key?'3px solid '+accent:'none',outlineOffset:2,lineHeight:1.5}},
        h('span',{'aria-hidden':true,style:{display:'inline-flex',alignItems:'center',justifyContent:'center',flex:'0 0 18px',height:18,marginTop:1,border:'1px solid '+(active?accent:line),borderRadius:role==='checkbox'?5:9,background:active?accent:'transparent',color:'#ffffff',fontSize:12,fontWeight:700}},active?'✓':''),
        h('span',{style:{minWidth:0,overflowWrap:'anywhere'}},label));
    return h('section',{className:'webling-question-card','aria-label':'업무 질문',style:{boxSizing:'border-box',padding:'16px',background:'#ffffff',color:'#203247',colorScheme:'light',border:'1px solid #d6dee7',borderTop:'4px solid '+statusColor,borderRadius:14,width:'100%',maxWidth:560,lineHeight:1.55,fontFamily:'inherit',fontSize:14,overflowWrap:'anywhere'}},
      h('div',{className:'wq-status',style:{display:'flex',alignItems:'center',gap:7,width:'fit-content',maxWidth:'100%',padding:'5px 9px',borderRadius:6,fontSize:12,fontWeight:650,color:statusColor,background:statusBackground,marginBottom:12}},
        h('span',{'aria-hidden':true,style:{width:6,height:6,borderRadius:'50%',background:statusColor}},''),sent?'답변 전송 요청됨':'답변을 기다리고 있어요'),
      q.title!=='요청 내용 확인'&&h('h3',{style:{fontSize:16,fontWeight:650,margin:'0 0 8px',lineHeight:1.45}},q.title),
      h('div',{className:'wq-prompt',style:{fontSize:14,margin:'0 0 16px',lineHeight:1.65}},...promptBlocks(q.prompt)),
      sent?h('div',{role:'status',style:{padding:'12px 14px',background:accentTint,color:'#174780',border:'1px solid #b9cdee',borderRadius:10}},
        h('strong',{style:{display:'block',fontSize:12,marginBottom:4}},'내가 보낸 답변'),h('p',{style:{whiteSpace:'pre-wrap',margin:'0 0 8px',fontSize:14}},sent),
        h('span',{style:{fontSize:12,color:muted}},'이 카드는 보낸 답변을 표시합니다. 실제 전송 여부와 이후 진행은 대화에서 확인해 주세요.')):
      h('form',{onSubmit:submit,style:{margin:0}},
        q.options.length>0&&!custom&&h('div',{role:q.mode==='multiple'?'group':'radiogroup','aria-label':q.mode==='multiple'?'여러 항목 선택 가능':'한 항목 선택',style:{display:'flex',flexDirection:'column',gap:7}},
          h('span',{style:{fontSize:12,color:muted,marginBottom:1}},q.mode==='multiple'?'해당하는 항목을 모두 선택해 주세요':'하나를 선택해 주세요'),
          ...q.options.map((label,i)=>option(label,'choice-'+i,!custom&&selected.includes(i),()=>{setCustom(false);setSelected(old=>q.mode==='multiple'?(old.includes(i)?old.filter(v=>v!==i):[...old,i]):[i]);},q.mode==='multiple'?'checkbox':'radio',i))),
        q.options.length>0&&h('button',{type:'button','aria-expanded':custom,onClick:()=>setCustom(old=>!old),onFocus:()=>setFocus('custom'),onBlur:()=>setFocus(''),
          style:{...resetButton,display:'block',minHeight:44,padding:'8px 0',marginTop:4,border:0,background:'transparent',fontSize:13,color:accent,textDecoration:'underline',textUnderlineOffset:3,outline:focus==='custom'?'3px solid '+accent:'none',outlineOffset:2}},custom?'선택지로 돌아가기':'직접 입력하기'),
        custom&&h('label',{style:{display:'block',fontSize:12,color:muted,marginTop:q.options.length?12:0}},'답변',
          h('textarea',{autoFocus:q.options.length>0,rows:2,maxLength:4000,placeholder:'원하는 기준이나 참고 내용을 적어 주세요',value:note,onChange:e=>setNote(e.target.value),onFocus:()=>setFocus('note'),onBlur:()=>setFocus(''),
            style:{appearance:'none',display:'block',width:'100%',minHeight:84,boxSizing:'border-box',font:'inherit',fontSize:14,lineHeight:1.6,color:'#203247',background:wash,border:'1px solid '+line,padding:'10px 12px',marginTop:6,borderRadius:10,resize:'vertical',outline:focus==='note'?'3px solid '+accent:'none',outlineOffset:2}})),
        h('div',{style:{display:'flex',justifyContent:'flex-end',marginTop:12}},h('button',{type:'submit',disabled:!ready,onFocus:()=>setFocus('send'),onBlur:()=>setFocus(''),
          style:{...resetButton,minHeight:42,padding:'9px 16px',border:'1px solid transparent',borderRadius:10,fontSize:13,fontWeight:650,background:ready?accent:'#e5eaf0',color:ready?'#ffffff':'#56657a',cursor:ready?'pointer':'not-allowed',outline:focus==='send'?'3px solid '+accent:'none',outlineOffset:2}},'답변 보내기',h('span',{'aria-hidden':true,style:{marginLeft:9}},'→'))),
        connection.status!=='ready'&&h('p',{role:'status',style:{fontSize:12,margin:'8px 0 0',color:muted}},'Buzz에 연결되면 답변을 보낼 수 있어요.'),
        h('p',{style:{fontSize:12,lineHeight:1.5,color:muted,margin:'10px 0 0'}},'채팅에서 담당 에이전트를 멘션해 답해도 돼요.')),
      error&&h('p',{role:'alert',style:{fontSize:13,margin:'10px 0 0',padding:'10px 12px',borderRadius:8,borderInlineStart:'4px solid #9b2635',background:'#fff0f2',color:'#9b2635'}},error));
  }
  function QuestionCard({message}) {
    const connection=R.useSyncExternalStore(ctx.relay.subscribe,ctx.relay.snapshot);
    return h(QuestionForm,{key:`${connection.scope}:${connection.generation}:${message.id}:${parseQuestion(message).id}`,message,connection});
  }
  ctx.conversation.registerMessage({id:'work-question',title:'Buzz 대화 카드 질문',matches:message=>!!parseQuestion(message),component:QuestionCard});
  ctx.conversation.registerMessage({id:'work-answer',title:'위블링 질문 답변',matches:message=>!!parseAnswer(message),component:({message})=>{
    const answer=parseAnswer(message);
    return h('div',{style:{fontFamily:'inherit',lineHeight:1.6}},
      h('div',{style:{fontSize:11,opacity:.7,marginBottom:4}},answer.label),
      h('div',{style:{fontSize:14,whiteSpace:'pre-wrap',overflowWrap:'anywhere'}},answer.text));
  }});
}


export function parseResourceCard(message) {
  if(typeof message?.content!=='string'||message.content.length>800)return null;
  // Current notices use a readable first-party link; retain old cards for history.
  if(!message.content.includes('[webling-resource:')&&message.content.startsWith('자료 연결이 필요합니다.\n')) {
    const links=message.content.match(/^https:\/\/buzz\.webling\.kr\/connect\/\?request=([a-f0-9]{32})$/gm)||[];
    if(links.length!==1)return null;
    const url=links[0],id=url.slice(-32);
    return {id,ready:true,url};
  }
  const match=message.content.match(/\[webling-resource:v1:([a-f0-9]{32}):(ready|unavailable)\]$/);
  if(!match||(message.content.match(/\[webling-resource:/g)||[]).length!==1)return null;
  const url='https://buzz.webling.kr/connect/?request='+match[1];
  if(match[2]==='ready'&&!message.content.includes('\n'+url+'\n'))return null;
  return {id:match[1],ready:match[2]==='ready',url};
}
function registerResourceCards(ctx) {
  const h=ctx.react.createElement;
  ctx.conversation.registerMessage({id:'resource-connection',title:'내 자료 연결',matches:message=>!!parseResourceCard(message),component:({message})=>{
    const card=parseResourceCard(message);
    return h('section',{'aria-label':'개인 자료 연결',style:{padding:16,border:'1px solid #c4cddb',borderTop:'4px solid #174ea6',borderRadius:14,background:'#ffffff',color:'#203247',lineHeight:1.6}},
      h('strong',null,card.ready?'내 권한으로 자료 연결':'자료 연결 준비 중'),
      h('p',null,card.ready?'원래 요청자가 로그인하고 이 업무에서만 읽도록 승인해 주세요.':'아직 로그인 실행 환경이 준비되지 않았습니다. 계정 정보를 보내지 마세요.'),
      card.ready&&h('a',{href:card.url,target:'_blank',rel:'noopener noreferrer',style:{display:'inline-block',padding:'10px 16px',borderRadius:8,background:'#174ea6',color:'#ffffff',textDecoration:'none',fontWeight:600}},'내 계정으로 연결'),
      h('p',{style:{fontSize:12,color:'#526174'}},'어드민 계정은 필요하지 않습니다. 비밀번호·인증 코드는 Buzz 대화에 보내지 마세요.'));
  }});
}


// Presentation only: matching a card never grants authority or starts work.
// One semantic palette for every card (approved readability mockup, 2026-11-02).
export const TONES={
  info:{fg:'#174ea6',bg:'#edf3ff',ink:'#16325f'},
  done:{fg:'#226447',bg:'#edf7f1',ink:'#173f2d'},
  warn:{fg:'#805215',bg:'#fff6e7',ink:'#5c3b0e'},
  danger:{fg:'#a42a2a',bg:'#fdeeee',ink:'#5f1717'},
  guess:{fg:'#5b3fa8',bg:'#f3efff',ink:'#3b2873'},
  muted:{fg:'#4b5563',bg:'#f1f3f6',ink:'#374151'},
};
const CALLOUT_TONES={'결론':'info','정보':'info','완료':'done','확인':'done','주의':'warn','요청':'warn','위험':'danger','금지':'danger','가설':'guess','미확인':'muted'};
const STATUS_TONES={'확인':'done','완료':'done','통과':'done','가설':'guess','검토 중':'guess','미확인':'muted','진행 중':'info','실패':'danger','차단':'warn'};
export function statusTone(word){return STATUS_TONES[String(word).trim()]||null;}

// A small Markdown subset. Everything else stays literal text; message HTML never runs.
function managementLink(value){
  try{const u=new URL(value);return u.hostname==='buzz.webling.kr'&&/^\/(admin|work)(\/|$)/.test(u.pathname);}catch{return false;}
}
export function inlineTokens(text){
  return String(text).split(/(\*\*[^*\n]+\*\*|==[^=\n]+==|`[^`\n]+`|\[[^\]\n]+\]\(https:\/\/[^\s()]+\)|https:\/\/[^\s<>]+)/g).filter(Boolean).map(part=>{
    if(/^\*\*[^*\n]+\*\*$/.test(part))return {type:'bold',text:part.slice(2,-2)};
    if(/^==[^=\n]+==$/.test(part))return {type:'mark',text:part.slice(2,-2)};
    if(/^`[^`\n]+`$/.test(part))return {type:'code',text:part.slice(1,-1)};
    const link=part.match(/^\[([^\]\n]+)\]\((https:\/\/[^\s()]+)\)$/);
    if(link)return managementLink(link[2])?{type:'text',text:link[1]+' (대화에서 전체 결과를 요청해 주세요)'}:{type:'link',text:link[1],href:link[2]};
    if(/^https:\/\/[^\s<>]+$/.test(part))return managementLink(part)?{type:'text',text:'관리 화면 링크 대신 대화에서 전체 결과를 요청해 주세요.'}:{type:'link',text:part,href:part};
    return {type:'text',text:part};
  });
}
const TABLE_RULE=/^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/;
const CALLOUT=/^> ?\[!(결론|정보|완료|확인|주의|요청|위험|금지|가설|미확인)\]\s*(.*)$/;
const HEADING=/^(?:#{3,4} (.+)|\*\*([^*\n]+)\*\*)$/;
const LIST=/^\s*(?:[-*]|\d+\.) /;
// "- 확인: …" items (and older "확인한 내용: …" lines) carry a status badge.
const ITEM_STATUS=/^(확인한 내용|확인|남은 확인|미확인|가설|완료): (.+)$/;
function itemStatus(text){
  const m=text.match(ITEM_STATUS);
  return m?{status:m[1]==='확인한 내용'?'확인':m[1]==='남은 확인'?'미확인':m[1],text:m[2]}:{text};
}
function cells(line){return line.trim().replace(/^\|/,'').replace(/\|$/,'').split('|').map(x=>x.trim());}
function tableStart(lines,i){return lines[i].trim().startsWith('|')&&TABLE_RULE.test(lines[i+1]||'');}
export function parseBlocks(text){
  const lines=String(text).replace(/\r\n?/g,'\n').split('\n'),blocks=[];
  let i=0;
  while(i<lines.length){
    const line=lines[i];
    if(!line.trim()){i++;continue;}
    const callout=line.match(CALLOUT);
    if(callout){
      const body=callout[2]?[callout[2]]:[];i++;
      while(i<lines.length&&/^>/.test(lines[i])&&!CALLOUT.test(lines[i])){body.push(lines[i].replace(/^> ?/,''));i++;}
      blocks.push({type:'callout',label:callout[1],tone:CALLOUT_TONES[callout[1]],text:body.join('\n').trim()});continue;
    }
    if(tableStart(lines,i)){
      const head=cells(line),rows=[];i+=2;
      while(i<lines.length&&lines[i].trim().startsWith('|')){rows.push(cells(lines[i]));i++;}
      blocks.push({type:'table',head,rows});continue;
    }
    const heading=line.match(HEADING);
    if(heading){blocks.push({type:'heading',text:(heading[1]||heading[2]).trim()});i++;continue;}
    if(LIST.test(line)){
      const ordered=/^\s*\d+\. /.test(line),items=[];
      while(i<lines.length&&LIST.test(lines[i])&&/^\s*\d+\. /.test(lines[i])===ordered){items.push(itemStatus(lines[i].replace(LIST,'')));i++;}
      blocks.push({type:ordered?'ol':'ul',items});continue;
    }
    if(ITEM_STATUS.test(line)){
      const items=[];
      while(i<lines.length&&ITEM_STATUS.test(lines[i])){items.push(itemStatus(lines[i]));i++;}
      blocks.push({type:'ul',items});continue;
    }
    const para=[line];i++;
    while(i<lines.length&&lines[i].trim()&&!CALLOUT.test(lines[i])&&!HEADING.test(lines[i])&&!LIST.test(lines[i])&&!ITEM_STATUS.test(lines[i])&&!tableStart(lines,i)){para.push(lines[i]);i++;}
    blocks.push({type:'p',text:para.join('\n')});
  }
  return blocks;
}

// Progress notices need no reply: one line, details on demand.
const PROGRESS={'진행 상황을 알려드립니다':['진행','info'],'작성 중입니다':['진행','info'],'분석 중입니다':['진행','info'],'자료를 준비하고 있습니다':['진행','info'],'결과를 확인하고 있습니다':['검토','guess'],'검토를 마무리하고 있습니다':['검토','guess']};
const NO_REPLY=/\n*지금은 답변하지 않으셔도 됩니다\.[^\n]*$/;
const HANDOFF_LINE=/^(인계|검토): ([^\n→]{1,60}) → ([^\n→]{1,60})$/;
// A handoff plays once, only when it has just arrived (approved handoff mockup B, 2026-11-02).
const PLAYED=new Set();
export function handoffFresh(message,now=Date.now()/1000){
  const age=now-message?.createdAt;
  return !!message?.id&&!PLAYED.has(message.id)&&typeof message.createdAt==='number'&&age>=0&&age<60;
}
export function handoffEnd(p){return p.handoff.kind==='검토'?['검토 시작','guess']:/후속/.test(p.summary)?['후속 작업 시작','done']:['작업 시작','done'];}
const HANDOFF_CSS='@keyframes wb-handoff-flash{0%{background:#e3edff;border-color:#b9cdee}100%{background:#fafbfc;border-color:#e3e6ea}}'+
  '@keyframes wb-handoff-draw{from{width:0}to{width:100%}}'+
  '@keyframes wb-handoff-pop{0%{opacity:0;transform:scale(.6)}70%{opacity:1;transform:scale(1.08)}100%{opacity:1;transform:scale(1)}}'+
  '.wb-handoff-new{animation:wb-handoff-flash 1.2s ease-out 1}.wb-handoff-new .wb-handoff-fill{animation:wb-handoff-draw .7s ease-in-out 1 both}'+
  '.wb-handoff-new .wb-handoff-ok{animation:wb-handoff-pop .45s ease-out .6s 1 both}'+
  '@media (prefers-reduced-motion: reduce){.wb-handoff-new,.wb-handoff-new .wb-handoff-fill,.wb-handoff-new .wb-handoff-ok{animation:none}}';
// The editor's fixed start reply; shown as one quiet line instead of a chat bubble.
export function isStartNote(message){return typeof message?.content==='string'&&message.content.trim()==='작업을 시작했습니다.';}
export function parseProgress(message){
  const text=message?.content;
  if(typeof text!=='string'||text.length>2600||text.includes('[webling-')||text.includes('\n**다음**\n'))return null;
  const [first,...rest]=text.split('\n');
  const head=first.match(/^### (.+)$/)?.[1];
  const label=head&&Object.keys(PROGRESS).find(value=>head.startsWith(value+' · '));
  if(!label)return null;
  const body=rest.join('\n').replace(NO_REPLY,'').replace(/^\s*\*\*진행 내용\*\*\s*\n/,'').trim();
  const parts=body.split(/\n\s*\n/).map(x=>x.trim()).filter(Boolean);
  // Older notices put the prior review first; the status line is the actor sentence.
  if(parts.length>1&&parts[0].startsWith('앞선 검토: '))[parts[0],parts[1]]=[parts[1],parts[0]];
  const lead=(parts.shift()||'').match(/^([^\n]+?다\.)(?:\s+([\s\S]+))?$/);
  if(!lead||lead[1].length>200)return null;
  if(lead[2])parts.unshift(lead[2]);
  let handoff=null;
  const kept=parts.filter(part=>{const m=part.match(HANDOFF_LINE);if(!m||handoff)return true;handoff={kind:m[1],from:m[2].trim(),to:m[3].trim()};return false;});
  const blocks=parseBlocks(kept.join('\n\n'));
  const checked=b=>(b.type==='ul'||b.type==='ol')&&b.items.every(x=>x.status);
  return {label,tag:PROGRESS[label][0],tone:PROGRESS[label][1],title:head.slice(label.length+3).trim(),
    summary:lead[1],handoff,actor:lead[1].match(/^((?:[A-Za-z0-9._-]+ ?){1,5}|담당 에이전트)가 /)?.[1]?.trim()||'',
    items:blocks.filter(checked).flatMap(b=>b.items),details:blocks.filter(b=>!checked(b))};
}

const REPORT_LABELS = new Set(['요청을 받았습니다','작성 중입니다','분석 중입니다','결과를 확인하고 있습니다','검토를 마무리하고 있습니다','자료를 준비하고 있습니다','진행 상황을 알려드립니다','확인해 주세요','수정 요청을 반영합니다','보류 중입니다','확정했습니다','정책에 따라 완료했습니다','진행이 멈췄습니다','업무를 취소했습니다','상태 확인이 필요합니다','결과 제출 · 검토 미배정']);
export function parseReportCard(message) {
  const text=message?.content;
  if(typeof text!=='string'||text.length>2600||parseQuestion(message)||text.includes('[webling-'))return null;
  const legacy=text.match(/^진행이 멈췄습니다 · ([^\n]+)\n검증: ([^\n]+)\n다음: ([\s\S]+)$/);
  if(legacy){
    const internal=/remaining_assignments|rounds_remaining/.test(legacy[3]);
    const exhausted=/remaining_assignments=0/.test(legacy[3])&&/rounds_remaining=0/.test(legacy[3]);
    return {label:'진행이 멈췄습니다',title:legacy[1],original:internal?legacy[3]:null,
      lines:['**확인 상태**',legacy[2],'**다음**',internal?(exhausted?'자동 조사 한도에 도달했습니다. 기존 조사 결과를 보존한 채 후속 조사 조건을 확인해야 합니다.':'추가 조사 조건을 확인해야 합니다. 기존 안내는 아래 원문에 보존했습니다.'):legacy[3]]};
  }
  const lines=text.split('\n');
  const head=lines.shift().match(/^### (?:✓ )?(.+)$/)?.[1];
  const label=head&&[...REPORT_LABELS].find(value=>head.startsWith(value+' · '));
  const title=label?head.slice(label.length+3):'';
  if(!label||!title)return null;
  if(!lines.includes('**다음**')){
    // Compact status answers end with the next step as their last plain paragraph.
    let end=lines.length;while(end>0&&!lines[end-1].trim())end--;
    let begin=end;while(begin>0&&lines[begin-1].trim())begin--;
    if(begin===end||begin===0||/^[|>#*-]/.test(lines[begin]))return null;
    lines.splice(begin,0,'**다음**');
  }
  return {label,title,lines};
}
const STEP_AT={'요청을 받았습니다':1,'작성 중입니다':1,'분석 중입니다':1,'자료를 준비하고 있습니다':1,'진행 상황을 알려드립니다':1,'수정 요청을 반영합니다':1,
  '결과를 확인하고 있습니다':2,'검토를 마무리하고 있습니다':2,'결과 제출 · 검토 미배정':2,'확인해 주세요':3,'보류 중입니다':3,'확정했습니다':4,'정책에 따라 완료했습니다':4};
export function reportStep(label){return label in STEP_AT?STEP_AT[label]:null;}
// "미완료" contains "완료": check the unfinished words first.
export function verificationTone(value){return /미완료|미확인|차단|필요|전$/.test(value)?'warn':/통과|완료/.test(value)?'done':'muted';}
export const FULL_REQUEST='전체 결과 보여줘';
const FULL_HINT='전체 내용이 필요하면 “전체 결과 보여줘”라고 이 대화에 답해 주세요.';
// Admin-only web links in older messages are hidden; requesters continue in chat.
const WEB_LINK=/^(?:결과 보기|수정 요청·확정·보류|질문에 답하기): https:\/\/buzz\.webling\.kr\/work\//;
export function reportSections(report){
  const sections=[],rows=[];
  let current=null,meta=false,full=false,partial=false;
  for(const line of report.lines){
    if(line===FULL_HINT){full=true;continue;}
    if(WEB_LINK.test(line)||line==='본문 일부를 표시했습니다.'){partial=partial||line==='본문 일부를 표시했습니다.';continue;}
    if(line==='| 항목 | 내용 |'){meta=true;continue;}
    if(meta){
      if(line.trim().startsWith('|')){const c=cells(line);if(c.length===2&&!TABLE_RULE.test(line))rows.push({key:c[0],value:c[1]});continue;}
      meta=false;
    }
    const heading=line.match(/^\*\*(.+)\*\*$/);
    if(heading){current={title:heading[1],lines:[]};sections.push(current);continue;}
    if(!current){current={title:'',lines:[]};sections.push(current);}
    current.lines.push(line);
  }
  return {sections:sections.map(s=>({title:s.title,blocks:parseBlocks(s.lines.join('\n'))})).filter(s=>s.blocks.length),rows,full,partial};
}
// Only explicitly labelled developer detail is collapsed. Never infer success,
// shorten evidence, or hide warnings/questions based on technical-looking words.
const DETAIL_TITLES=new Set(['개발 상세','기술 상세','검사 상세']);
// Uncertain/failing detail stays expanded. This only affects presentation;
// it never removes text or decides that a task is complete.
export function detailNeedsAttention(blocks){
  return /미완료|미확인|미검증|실패|차단|못했|못한|않았|아직|위험|주의|금지|error|failed|blocked|timeout/i.test(JSON.stringify(blocks));
}
export function groupDetails(list){
  const result=[];
  for(let i=0;i<list.length;i++){
    const block=list[i];
    if(block.type==='heading'&&DETAIL_TITLES.has(block.text)){
      const children=[];
      while(i+1<list.length&&list[i+1].type!=='heading'
            && !(list[i+1].type==='callout'&&['주의','위험','요청','금지','미확인'].includes(list[i+1].label)))children.push(list[++i]);
      result.push({type:'details',title:block.text,blocks:children});
    }else result.push(block);
  }
  return result;
}
export function displayStatus(value){
  return ({'결과 제출 · 검토 미배정':'검토 대기',
    '독립 검토 미완료':'별도 검토가 아직 끝나지 않았어요',
    '독립 검토 통과 · 사람 확인 전':'검토 통과 · 사용자 확인 전',
    '검토에서 미확인·차단 사항 있음':'확인하지 못한 내용이 있어요',
    '결과가 달라져 재검토 필요':'수정된 내용을 다시 검토해야 해요'})[value]||value;
}
export function canAskFull(message){return /^[a-f0-9]{64}$/.test(message?.authorId||'')&&!!message?.channelId&&/^[a-f0-9]{64}$/.test(message?.threadRootId||'');}
export function requestFull(connection,message){
  if(connection?.status!=='ready'||!canAskFull(message))throw Error('원래 업무 스레드에서 요청해 주세요.');
  // Same signed-reply path as question answers; returns an outbox ID, not a server result.
  return connection.session.messages.reply(message.channelId,message.threadRootId,FULL_REQUEST,[message.authorId],[],message.id);
}

// Agent replies opt in by using a callout; plain chat keeps the host renderer.
export function parseRichMessage(message){
  const text=message?.content;
  if(typeof text!=='string'||text.length>8000||text.includes('[webling-')||!/^> ?\[!(결론|정보|완료|확인|주의|요청|위험|금지|가설|미확인)\]/m.test(text))return null;
  const lines=text.replace(/\r\n?/g,'\n').split('\n');
  const title=lines[0].match(/^#{2,3} (.+)$/)?.[1]?.trim()||'';
  return {title,blocks:parseBlocks(title?lines.slice(1).join('\n'):text)};
}

function registerReportCards(ctx) {
  const R=ctx.react,h=R.createElement;
  const ink='#203247',muted='#526174',line='#e3e6ea';
  const cardStyle=border=>({boxSizing:'border-box',width:'100%',maxWidth:560,border:'1px solid '+border,borderRadius:16,background:'#ffffff',color:ink,colorScheme:'light',fontFamily:'inherit',fontSize:14,lineHeight:1.6,overflowWrap:'anywhere',overflow:'hidden'});
  const chip=(text,tone,key)=>h('span',{key,style:{flex:'none',display:'inline-block',padding:'1px 8px',borderRadius:999,fontSize:12,fontWeight:650,whiteSpace:'normal',maxWidth:'100%',overflowWrap:'anywhere',background:TONES[tone].bg,color:TONES[tone].fg}},text);
  function inline(text){
    return inlineTokens(text).map((t,i)=>
      t.type==='bold'?h('strong',{key:i},t.text):
      t.type==='mark'?h('mark',{key:i,style:{background:'#fff3b0',color:'inherit',padding:'0 3px',borderRadius:3}},t.text):
      t.type==='code'?h('code',{key:i,style:{fontFamily:'ui-monospace,SFMono-Regular,Menlo,monospace',fontSize:12,padding:'1px 5px',borderRadius:5,background:'#f1f3f6'}},t.text):
      t.type==='link'?h('a',{key:i,href:t.href,target:'_blank',rel:'noopener noreferrer',style:{color:TONES.info.fg,textDecoration:'underline',overflowWrap:'anywhere'}},t.text):t.text);
  }
  function itemLine(item,key){
    return h('li',{key,style:{display:'flex',gap:8,alignItems:'flex-start',margin:'4px 0'}},item.status&&chip(item.status,statusTone(item.status)||'muted'),h('span',{style:{minWidth:0}},...inline(item.text)));
  }
  function callout(label,tone,text,key){
    const t=TONES[tone];
    return h('div',{key,style:{borderRadius:12,padding:'10px 14px',background:t.bg,color:t.ink,margin:'8px 0'}},
      h('strong',{style:{display:'block',fontSize:12,color:t.fg,marginBottom:2}},label),h('div',{style:{whiteSpace:'pre-wrap'}},...inline(text)));
  }
  function blocks(list){
    return groupDetails(list).map((b,i)=>{
      if(b.type==='details')return disclosure(b.title,blocks(b.blocks),i,detailNeedsAttention(b.blocks));
      if(b.type==='p')return h('div',{key:i},...b.text.split('\n').map((text,j)=>h('p',{key:j,style:{margin:'8px 0',whiteSpace:'pre-wrap'}},...inline(text))));
      if(b.type==='heading')return h('h4',{key:i,style:{fontSize:12,color:muted,fontWeight:650,margin:'14px 0 4px'}},b.text);
      if(b.type==='callout')return callout(b.label,b.tone,b.text,i);
      if(b.type==='ul')return h('ul',{key:i,style:{listStyle:b.items.every(x=>x.status)?'none':'disc',margin:'6px 0',paddingLeft:b.items.every(x=>x.status)?0:20}},...b.items.map((x,j)=>x.status?itemLine(x,j):h('li',{key:j,style:{margin:'3px 0'}},...inline(x.text))));
      if(b.type==='ol')return h('ol',{key:i,style:{listStyle:'none',margin:'8px 0',padding:0,display:'flex',flexDirection:'column',gap:6}},...b.items.map((x,j)=>h('li',{key:j,style:{display:'flex',gap:10,alignItems:'flex-start',padding:'8px 10px',border:'1px solid '+line,borderRadius:10}},
        h('span',{'aria-hidden':true,style:{flex:'0 0 22px',height:22,borderRadius:'50%',background:TONES.info.bg,color:TONES.info.fg,fontSize:12,fontWeight:700,display:'inline-flex',alignItems:'center',justifyContent:'center'}},String(j+1)),
        x.status&&chip(x.status,statusTone(x.status)||'muted'),h('span',{style:{minWidth:0}},...inline(x.text)))));
      if(b.type==='table')return h('div',{key:i,style:{overflowX:'auto',margin:'8px 0'}},h('table',{style:{width:'100%',borderCollapse:'collapse',fontSize:13,lineHeight:1.5}},
        h('thead',null,h('tr',null,...b.head.map((c,j)=>h('th',{key:j,scope:'col',style:{textAlign:'left',fontSize:12,fontWeight:650,color:muted,padding:'7px 8px',background:'#f6f7f9',borderBottom:'1px solid #e5e8ec'}},...inline(c))))),
        h('tbody',null,...b.rows.map((row,r)=>h('tr',{key:r},...row.map((c,j)=>h('td',{key:j,style:{padding:'8px',borderBottom:'1px solid #eef0f3',verticalAlign:'top'}},statusTone(c)?chip(c,statusTone(c)):inline(c))))))));
      return null;
    });
  }
  function disclosure(title,content,key,open=false){
    return h('details',{key,open,className:'webling-technical-details',style:{margin:'12px 0 4px',borderTop:'1px solid '+line,paddingTop:6}},
      h('summary',{style:{cursor:'pointer',padding:'8px 0',fontSize:13,color:muted,fontWeight:600}},title+' 보기'),
      h('div',{style:{padding:'2px 0 8px',fontSize:13}},...content));
  }
  function FullResult({message}) {
    const connection=ctx.relay?.snapshot?R.useSyncExternalStore(ctx.relay.subscribe,ctx.relay.snapshot):null;
    const [state,setState]=R.useState(''),busy=R.useRef(false);
    const ready=connection?.status==='ready'&&canAskFull(message)&&state!=='sent';
    function ask(){if(busy.current||!ready)return;busy.current=true;
      try{requestFull(connection,message);setState('sent');}catch(err){busy.current=false;setState('error');}}
    return h('div',{style:{display:'flex',alignItems:'center',flexWrap:'wrap',gap:10,padding:'4px 18px 18px'}},
      h('button',{type:'button',onClick:ask,disabled:!ready,style:{appearance:'none',font:'inherit',fontSize:13,fontWeight:600,minHeight:44,padding:'8px 14px',borderRadius:10,border:'1px solid #cfd6df',background:'#ffffff',color:ready?ink:'#6b7280',cursor:ready?'pointer':'default'}},state==='sent'?'요청을 보냈어요':'전체 결과 요청'),
      state==='error'?h('span',{role:'alert',style:{fontSize:12,color:TONES.danger.fg}},'보내지 못했어요. “전체 결과 보여줘”라고 답해 주세요.'):
      !ready&&state!=='sent'&&h('span',{style:{fontSize:12,color:muted}},'“전체 결과 보여줘”라고 답해도 돼요.'));
  }
  function ReportCard({message}) {
    const report=parseReportCard(message),parts=reportSections(report);
    const stopped=['진행이 멈췄습니다','상태 확인이 필요합니다','업무를 취소했습니다'].includes(report.label);
    const tone=stopped?'warn':reportStep(report.label)===4?'done':'info',t=TONES[tone];
    const named=key=>parts.rows.find(r=>r.key===key)?.value;
    const action=['누가','무엇을','그다음'].filter(named);
    const next=parts.sections.find(s=>s.title==='다음');
    const body=parts.sections.filter(s=>s!==next&&!DETAIL_TITLES.has(s.title));
    const technical=parts.sections.filter(s=>DETAIL_TITLES.has(s.title));
    const attention=b=>b.type==='callout'&&['주의','위험','요청','금지','미확인'].includes(b.label);
    const detailAlerts=technical.flatMap(s=>s.blocks.filter(attention));
    // Long historical reports keep every word, but put actionable state first.
    const longBody=body.reduce((n,s)=>n+s.blocks.reduce((m,b)=>m+(b.text||JSON.stringify(b)).length,0),0)>800;
    const renderBody=()=>body.map((s,i)=>h('div',{key:i},s.title&&h('h4',{style:titleStyle},s.title==='무엇이 바뀌었나요'?'작업 요약':s.title),...blocks(s.blocks)));
    const titleStyle={fontSize:13,color:muted,fontWeight:650,margin:'16px 0 6px'};
    return h('section',{'aria-label':'업무 진행과 결과',className:'webling-report-card',style:cardStyle('#dfe4ea')},
      h('header',{style:{padding:'16px 18px 0'}},
        chip(report.label==='진행이 멈췄습니다'?'진행 중단':displayStatus(report.label),tone),
        h('h3',{style:{margin:'10px 0 0',fontSize:17,lineHeight:1.5,fontWeight:700,color:'#16202c'}},report.title)),
      h('div',{style:{padding:'0 18px 12px'}},
        ...(!longBody?renderBody():[]),
        parts.partial&&h('p',{style:{fontSize:13,color:muted,margin:'8px 0'}},'본문 일부입니다. 전체 결과를 요청할 수 있어요.'),
        ...blocks(detailAlerts),
        named('막힌 이유')&&callout('진행이 막힌 이유','warn',named('막힌 이유')),
        ...parts.rows.filter(r=>r.key==='검증').map((r,i)=>h('div',{key:'verification'+i,style:{margin:'12px 0',padding:'8px 0',borderTop:'1px solid '+line,fontSize:14}},
          h('span',{style:{fontWeight:600,marginRight:8}},'확인 상태'),h('span',{style:{color:TONES[verificationTone(r.value)].fg}},displayStatus(r.value)))),
        (next||action.length>0)&&h('section',{className:'webling-next-action','aria-label':'다음 진행',style:{margin:'14px 0',padding:'2px 0 2px 12px',borderLeft:'3px solid '+t.fg}},
          h('h4',{style:{fontSize:14,fontWeight:650,margin:'0 0 6px',color:ink}},'다음 진행'),
          ...action.map(key=>h('div',{key,style:{margin:'6px 0',fontSize:14}},h('strong',{style:{marginRight:8}},key==='누가'?'담당':key==='무엇을'?'할 일':'이후'),...inline(named(key)))),
          next&&h('div',null,...blocks(next.blocks))),
        ...parts.rows.filter(r=>!['검증','막힌 이유','누가','무엇을','그다음'].includes(r.key)).map((r,i)=>h('div',{key:'row'+i,style:{display:'grid',gridTemplateColumns:'60px minmax(0,1fr)',gap:10,padding:'8px 0',fontSize:14,borderTop:'1px solid '+line}},
          h('span',{style:{color:muted}},r.key),h('span',null,...inline(r.value)))),
        ...(longBody?renderBody():[]),
        ...technical.map((s,i)=>h('div',{key:'technical'+i},...blocks([{type:'heading',text:s.title},...s.blocks.filter(b=>!attention(b))]))),
        report.original&&h('details',{open:true,style:{marginTop:10,borderTop:'1px solid '+line,paddingTop:8,fontSize:13,color:muted}},h('summary',{style:{cursor:'pointer',padding:'8px 0'}},'기존 안내 원문'),h('p',{style:{whiteSpace:'pre-wrap'}},report.original))),
      parts.full&&h(FullResult,{message}));
  }

  function HandoffRow({message,p}) {
    const [fresh]=R.useState(()=>handoffFresh(message));
    R.useEffect(()=>{if(message.id)PLAYED.add(message.id);},[message.id]);
    const tone=p.handoff.kind==='검토'?'guess':'info',t=TONES[tone],[end,endTone]=handoffEnd(p);
    const clip={overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'};
    return h('details',{className:'webling-progress webling-handoff'+(fresh?' wb-handoff-new':''),style:{boxSizing:'border-box',width:'100%',maxWidth:560,border:'1px solid '+line,borderRadius:12,background:'#fafbfc',color:'#374151',colorScheme:'light',fontSize:13,lineHeight:1.55,overflowWrap:'anywhere'}},
      h('summary',{title:p.summary,style:{display:'flex',alignItems:'center',gap:8,padding:'9px 12px',cursor:'pointer'}},
        h('span',{'aria-hidden':true,style:{flex:'0 0 8px',height:8,borderRadius:'50%',background:t.fg}}),
        chip(p.handoff.kind,tone),
        h('span',{style:{display:'flex',alignItems:'center',gap:6,minWidth:0,flex:1}},
          h('span',{style:clip},p.handoff.from),
          h('span',{'aria-label':'에서',style:{position:'relative',flex:'1 1 24px',minWidth:16,height:2,borderRadius:1,background:'#e5e7eb',overflow:'hidden'}},
            h('span',{className:'wb-handoff-fill',style:{position:'absolute',top:0,bottom:0,left:0,width:'100%',background:t.fg}})),
          h('strong',{style:clip},p.handoff.to)),
        h('span',{className:'wb-handoff-ok',style:{flex:'none',fontSize:11,fontWeight:650,padding:'2px 8px',borderRadius:999,background:TONES[endTone].bg,color:TONES[endTone].fg}},end),
        h('span',{'aria-hidden':true,style:{color:'#9ca3af'}},'›')),
      h('style',null,HANDOFF_CSS),
      h('div',{style:{padding:'0 12px 10px 30px',color:muted}},
        h('div',{style:{fontSize:12,margin:'0 0 4px'}},p.title),h('p',{style:{margin:'4px 0'}},p.summary),...blocks(p.details),
        h('p',{style:{fontSize:12,margin:'4px 0 0'}},'답하지 않아도 돼요.')));
  }
  function ProgressCard({message}) {
    const p=parseProgress(message),t=TONES[p.tone];
    if(!p.items.length&&p.handoff)return h(HandoffRow,{message,p});
    if(p.items.length)return h('section',{'aria-label':'중간 결과',className:'webling-progress-card',style:cardStyle('#dfe4ea')},
      h('div',{style:{padding:'16px 18px 12px',borderBottom:'1px solid #eef0f3'}},
        h('span',{style:{display:'inline-block',padding:'4px 10px',borderRadius:999,background:TONES.warn.bg,color:TONES.warn.fg,fontSize:12,fontWeight:650}},'중간 결과 · 최종 아님'),
        p.actor&&h('span',{style:{fontSize:12,color:'#6b7280',marginLeft:8}},p.actor+' 조사'),
        h('h3',{style:{margin:'10px 0 0',fontSize:17,lineHeight:1.45,fontWeight:700,color:'#16202c'}},p.title)),
      h('div',{style:{padding:'10px 18px 16px'}},
        h('ul',{style:{listStyle:'none',margin:'4px 0',padding:0}},...p.items.map((x,i)=>itemLine(x,i))),
        ...blocks(p.details.filter(b=>!(b.type==='p'&&/^최종 검증 결과는 아닙니다\.?$/.test(b.text)))),
        callout('주의','warn','최종 검증 결과가 아니에요. 해결·검증 완료가 아닙니다.')));
    return h('details',{className:'webling-progress',style:{boxSizing:'border-box',width:'100%',maxWidth:560,border:'1px solid '+line,borderRadius:12,background:'#fafbfc',color:'#374151',colorScheme:'light',fontSize:13,lineHeight:1.55,overflowWrap:'anywhere'}},
      h('summary',{style:{display:'flex',alignItems:'center',gap:10,padding:'9px 12px',cursor:'pointer'}},
        h('span',{'aria-hidden':true,style:{flex:'0 0 8px',height:8,borderRadius:'50%',background:t.fg}}),
        chip(p.tag,p.tone),
        h('span',{style:{minWidth:0,flex:1}},...(p.actor?[h('strong',{key:'a'},p.actor),p.summary.slice(p.actor.length)]:[p.summary])),
        h('span',{'aria-hidden':true,style:{color:'#9ca3af'}},'›')),
      h('div',{style:{padding:'0 12px 10px 30px',color:muted}},
        h('div',{style:{fontSize:12,margin:'0 0 4px'}},p.title),...blocks(p.details),
        h('p',{style:{fontSize:12,margin:'4px 0 0'}},'답하지 않아도 돼요.')));
  }
  function RichMessage({message}) {
    const rich=parseRichMessage(message);
    return h('section',{'aria-label':rich.title||'에이전트 답변',className:'webling-rich-message',style:{...cardStyle('#dfe4ea'),padding:'12px 16px'}},
      rich.title&&h('h3',{style:{margin:'4px 0 6px',fontSize:16,lineHeight:1.45,fontWeight:700,color:'#16202c'}},rich.title),...blocks(rich.blocks));
  }
  ctx.conversation.registerMessage({id:'work-start-note',title:'위블링 작업 시작',matches:isStartNote,component:()=>
    h('div',{className:'webling-start-note',style:{display:'inline-flex',alignItems:'center',gap:8,padding:'6px 12px',border:'1px solid '+line,borderRadius:999,background:'#fafbfc',color:'#374151',fontSize:13}},
      h('span',{'aria-hidden':true,style:{width:8,height:8,borderRadius:'50%',background:TONES.info.fg}}),chip('진행','info'),'작업을 시작했습니다.')});
  ctx.conversation.registerMessage({id:'work-progress',title:'Buzz 대화 카드 진행 기록',matches:message=>!!parseProgress(message),component:ProgressCard});
  ctx.conversation.registerMessage({id:'work-report',title:'Buzz 대화 카드 진행·결과',matches:message=>!!parseReportCard(message),component:ReportCard});
  ctx.conversation.registerMessage({id:'agent-rich',title:'위블링 에이전트 답변',matches:message=>!!parseRichMessage(message),component:RichMessage});
}
