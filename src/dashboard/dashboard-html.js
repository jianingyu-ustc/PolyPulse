export function renderDashboardHtml() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>PolyPulse Monitor Dashboard</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,monospace;background:#0d1117;color:#c9d1d9;padding:16px;line-height:1.5}
h1{font-size:1.4em;color:#58a6ff;margin-bottom:8px}
h2{font-size:1.1em;color:#8b949e;margin:20px 0 8px;border-bottom:1px solid #21262d;padding-bottom:4px}
.header{display:flex;justify-content:space-between;align-items:center}
.lang-btn{background:#21262d;color:#8b949e;border:1px solid #30363d;border-radius:4px;padding:4px 10px;cursor:pointer;font-size:0.8em}
.lang-btn:hover{color:#c9d1d9;border-color:#58a6ff}
.meta{color:#8b949e;font-size:0.85em;margin-bottom:16px}
.summary{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin-bottom:20px}
.card{background:#161b22;border:1px solid #21262d;border-radius:6px;padding:12px}
.card .label{font-size:0.75em;color:#8b949e;text-transform:uppercase}
.card .value{font-size:1.3em;font-weight:600;color:#f0f6fc;margin-top:2px}
.positive{color:#3fb950}
.negative{color:#f85149}
table{width:100%;border-collapse:collapse;font-size:0.85em;margin-bottom:16px}
th{background:#161b22;color:#8b949e;text-align:left;padding:8px 6px;border-bottom:1px solid #21262d;white-space:nowrap}
td{padding:8px 6px;border-bottom:1px solid #21262d;max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
tr:hover td{background:#161b22}
.reasoning-row td{background:#0d1117;padding:8px 12px;border-bottom:1px solid #21262d;white-space:normal;font-size:0.82em;color:#c9d1d9}
.reasoning-row .reasoning-content{max-width:800px}
.reasoning-row .reasoning-label{color:#58a6ff;font-weight:600;font-size:0.75em;text-transform:uppercase;margin-bottom:4px}
.reasoning-row .reasoning-text{color:#c9d1d9;line-height:1.6;margin-top:4px}
.reasoning-row .evidence-list{margin-top:6px;color:#8b949e;font-size:0.9em}
.reasoning-row .evidence-list li{margin-left:16px;list-style:disc}
.confidence-badge{display:inline-block;padding:2px 6px;border-radius:3px;font-size:0.75em;font-weight:600;margin-left:8px}
.confidence-high{background:#1a3828;color:#3fb950}
.confidence-medium{background:#2d2a11;color:#d29922}
.confidence-low{background:#3d1d20;color:#f85149}
tr.expandable{cursor:pointer}
tr.expandable:hover td{background:#161b22}
.expand-icon{color:#8b949e;font-size:0.7em;margin-right:4px;display:inline-block;transition:transform 0.2s}
a{color:#58a6ff;text-decoration:none}
a:hover{text-decoration:underline}
.refresh{color:#8b949e;font-size:0.75em;margin-top:8px}
@media(max-width:600px){.summary{grid-template-columns:1fr 1fr}td,th{padding:4px 3px;font-size:0.78em}}
</style>
</head>
<body>
<div class="header">
  <h1>PolyPulse Monitor</h1>
  <button class="lang-btn" id="lang-btn" onclick="toggleLang()">EN</button>
</div>
<div class="meta" id="meta">Loading...</div>

<div class="summary" id="summary"></div>

<h2 id="h-open">Open Positions</h2>
<div style="overflow-x:auto"><table id="open-table"><thead><tr id="open-head">
</tr></thead><tbody id="open-body"></tbody></table></div>

<h2 id="h-closed">Closed Positions</h2>
<div style="overflow-x:auto"><table id="closed-table"><thead><tr id="closed-head">
</tr></thead><tbody id="closed-body"></tbody></table></div>

<h2 id="h-skipped">已跳过</h2>
<div style="overflow-x:auto"><table id="skipped-table"><thead><tr id="skipped-head">
</tr></thead><tbody id="skipped-body"></tbody></table></div>

<div class="refresh" id="refresh"></div>

<script>
var lang = localStorage.getItem('pp_lang') || 'zh';

var i18n = {
  zh: {
    title: 'PolyPulse Monitor',
    toggleBtn: 'EN',
    loading: '加载中...',
    hOpen: '持仓中',
    hClosed: '已关仓',
    noOpen: '暂无持仓',
    noClosed: '暂无已关仓',
    mode: '模式',
    started: '启动',
    startTime: '启动时间',
    runDays: '运行天数',
    initFund: '初始资金',
    cash: '现金',
    equity: '总权益',
    unrealPnl: '未实现盈亏',
    realPnl: '已实现盈亏',
    monthRet: '月化收益',
    annRet: '年化收益',
    winRate: '胜率',
    wl: '胜/负',
    maxDd: '最大回撤',
    thMarket: '市场',
    thSide: '方向',
    thOpenTime: '开仓时间',
    thExpiry: '到期时间',
    thAmount: '金额',
    thAiProb: 'AI概率',
    thMktProb: '市场概率',
    thEdge: 'Edge',
    thFee: '手续费',
    thNetEdge: 'Net Edge',
    thPnl: '盈亏',
    thCloseTime: '关仓时间',
    thReturn: '收益率',
    lastRefresh: '上次刷新',
    refreshFail: '刷新失败',
    days: '天',
    reasoning: 'AI推理',
    confidence: '置信度',
    evidence: '关键证据',
    noReasoning: '暂无推理信息',
    hSkipped: '本轮已跳过',
    noSkipped: '暂无跳过记录',
    thPhase: '阶段',
    thReason: '原因',
    thLiquidity: '流动性',
    thCategory: '分类',
    thTime: '时间'
  },
  en: {
    title: 'PolyPulse Monitor',
    toggleBtn: '中文',
    loading: 'Loading...',
    hOpen: 'Open Positions',
    hClosed: 'Closed Positions',
    noOpen: 'No open positions',
    noClosed: 'No closed positions',
    mode: 'Mode',
    started: 'Started',
    startTime: 'Start Time',
    runDays: 'Running Days',
    initFund: 'Initial Fund',
    cash: 'Cash',
    equity: 'Equity',
    unrealPnl: 'Unrealized PnL',
    realPnl: 'Realized PnL',
    monthRet: 'Monthly Return',
    annRet: 'Annual Return',
    winRate: 'Win Rate',
    wl: 'W/L',
    maxDd: 'Max Drawdown',
    thMarket: 'Market',
    thSide: 'Side',
    thOpenTime: 'Open Time',
    thExpiry: 'Expiry',
    thAmount: 'Amount',
    thAiProb: 'AI Prob',
    thMktProb: 'Mkt Prob',
    thEdge: 'Edge',
    thFee: 'Fee',
    thNetEdge: 'Net Edge',
    thPnl: 'PnL',
    thCloseTime: 'Close Time',
    thReturn: 'Return',
    lastRefresh: 'Last refresh',
    refreshFail: 'Refresh failed',
    days: ' days',
    reasoning: 'AI Reasoning',
    confidence: 'Confidence',
    evidence: 'Key Evidence',
    noReasoning: 'No reasoning available',
    hSkipped: 'Skipped This Round',
    noSkipped: 'No skipped candidates',
    thPhase: 'Phase',
    thReason: 'Reason',
    thLiquidity: 'Liquidity',
    thCategory: 'Category',
    thTime: 'Time'
  }
};

function t(key){ return i18n[lang][key] || key; }

function toggleLang(){
  lang = lang === 'zh' ? 'en' : 'zh';
  localStorage.setItem('pp_lang', lang);
  document.getElementById('lang-btn').textContent = t('toggleBtn');
  renderAll();
}

function fmt(n,d){return n==null?'-':Number(n).toFixed(d??2)}
function pct(n){return n==null?'-':(Number(n)*100).toFixed(2)+'%'}
function ts(s){if(!s)return'-';const d=new Date(s);return d.toLocaleDateString('zh-CN')+' '+d.toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'})}
function cls(n){return n>0?'positive':n<0?'negative':''}
function esc(s){return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')}
function marketLink(p){
  var url = p.marketUrl;
  if(!url && p.marketId){
    url = 'https://polymarket.com/event/' + encodeURIComponent(p.marketId);
  }
  var label = (p.question || p.marketSlug || p.marketId || '-');
  if(label.length > 40) label = label.slice(0,38) + '..';
  var title = p.question || p.marketSlug || p.marketId || '';
  if(url) return '<a href="'+esc(url)+'" target="_blank" title="'+esc(title)+'">'+esc(label)+'</a>';
  return '<span title="'+esc(title)+'">'+esc(label)+'</span>';
}

var _data = null;

function renderAll(){
  document.getElementById('h-open').textContent = t('hOpen');
  document.getElementById('h-closed').textContent = t('hClosed');
  document.getElementById('h-skipped').textContent = t('hSkipped');
  document.getElementById('open-head').innerHTML =
    '<th>'+[t('thMarket'),t('thSide'),t('thOpenTime'),t('thExpiry'),t('thAmount'),t('thAiProb'),t('thMktProb'),t('thEdge'),t('thFee'),t('thNetEdge'),t('thPnl')].join('</th><th>')+'</th>';
  document.getElementById('closed-head').innerHTML =
    '<th>'+[t('thMarket'),t('thSide'),t('thOpenTime'),t('thCloseTime'),t('thAmount'),t('thEdge'),t('thFee'),t('thNetEdge'),t('thPnl'),t('thReturn')].join('</th><th>')+'</th>';
  document.getElementById('skipped-head').innerHTML =
    '<th>'+[t('thMarket'),t('thCategory'),t('thLiquidity'),t('thPhase'),t('thReason'),t('thTime')].join('</th><th>')+'</th>';
  if(_data){
    document.getElementById('meta').textContent = t('mode')+': '+_data.executionMode+' | '+t('started')+': '+ts(_data.startedAt);
    renderSummary(_data.summary||{});
    renderOpen(_data.openPositions||[]);
    renderClosed(_data.closedPositions||[]);
    renderSkipped(_data.skippedCandidates||[]);
  }
}

function renderSummary(s){
  var items=[
    [t('startTime'),ts(window._data?.startedAt)],
    [t('runDays'),fmt(s.elapsedDays,1)+t('days')],
    [t('initFund'),'$'+fmt(s.initialCashUsd)],
    [t('cash'),'$'+fmt(s.cashUsd)],
    [t('equity'),'$'+fmt(s.totalEquityUsd)],
    [t('unrealPnl'),'$'+fmt(s.unrealizedPnlUsd),cls(s.unrealizedPnlUsd)],
    [t('realPnl'),'$'+fmt(s.realizedPnlUsd),cls(s.realizedPnlUsd)],
    [t('monthRet'),pct(s.monthlyReturnPct),cls(s.monthlyReturnPct)],
    [t('annRet'),pct(s.annualReturnPct),cls(s.annualReturnPct)],
    [t('winRate'),s.winRate!=null?pct(s.winRate):'-'],
    [t('wl'),s.wins+'/'+s.losses],
    [t('maxDd'),'$'+fmt(s.maxDrawdownUsd),'negative']
  ];
  document.getElementById('summary').innerHTML=items.map(function(a){
    return '<div class="card"><div class="label">'+a[0]+'</div><div class="value '+(a[2]||'')+'">'+a[1]+'</div></div>';
  }).join('');
}

function renderOpen(positions){
  var tbody=document.getElementById('open-body');
  if(!positions.length){tbody.innerHTML='<tr><td colspan="11" style="color:#8b949e">'+t('noOpen')+'</td></tr>';return}
  tbody.innerHTML=positions.map(function(p,idx){
    var mainRow='<tr class="expandable" onclick="toggleReasoning(\\\'open-'+idx+'\\\')">'+
    '<td><span class="expand-icon" id="icon-open-'+idx+'">&#9654;</span>'+marketLink(p)+'</td>'+
    '<td>'+(p.side||p.outcome||'-')+'</td>'+
    '<td>'+ts(p.openedAt)+'</td>'+
    '<td>'+ts(p.endDate)+'</td>'+
    '<td>$'+fmt(p.costUsd)+'</td>'+
    '<td>'+(p.aiProbability!=null?pct(p.aiProbability):'-')+'</td>'+
    '<td>'+(p.marketProbability!=null?pct(p.marketProbability):'-')+'</td>'+
    '<td class="positive">'+(p.edge!=null?pct(p.edge):'-')+'</td>'+
    '<td class="negative">'+(p.feeImpact!=null?pct(p.feeImpact):'-')+'</td>'+
    '<td class="positive">'+(p.netEdge!=null?pct(p.netEdge):'-')+'</td>'+
    '<td class="'+cls(p.unrealizedPnlUsd)+'">$'+fmt(p.unrealizedPnlUsd)+'</td>'+
    '</tr>';
    var reasoningRow='<tr class="reasoning-row" id="open-'+idx+'" style="display:none"><td colspan="11">'+
    '<div class="reasoning-content">'+
    '<span class="reasoning-label">'+t('reasoning')+'</span>'+
    (p.confidence?'<span class="confidence-badge confidence-'+p.confidence+'">'+esc(p.confidence)+'</span>':'')+
    '<div class="reasoning-text">'+(p.reasoningSummary?esc(p.reasoningSummary):'<em>'+t('noReasoning')+'</em>')+'</div>'+
    (p.keyEvidence&&p.keyEvidence.length?'<div class="evidence-list"><strong>'+t('evidence')+':</strong><ul>'+p.keyEvidence.map(function(e){return '<li>'+esc(e)+'</li>'}).join('')+'</ul></div>':'')+
    '</div></td></tr>';
    return mainRow+reasoningRow;
  }).join('');
}

function renderClosed(trades){
  var tbody=document.getElementById('closed-body');
  if(!trades.length){tbody.innerHTML='<tr><td colspan="10" style="color:#8b949e">'+t('noClosed')+'</td></tr>';return}
  tbody.innerHTML=trades.map(function(p,idx){
    var mainRow='<tr class="expandable" onclick="toggleReasoning(\\\'closed-'+idx+'\\\')">'+
    '<td><span class="expand-icon" id="icon-closed-'+idx+'">&#9654;</span>'+marketLink(p)+'</td>'+
    '<td>'+(p.side||p.outcome||'-')+'</td>'+
    '<td>'+ts(p.openedAt)+'</td>'+
    '<td>'+ts(p.closedAt)+'</td>'+
    '<td>$'+fmt(p.costUsd)+'</td>'+
    '<td class="positive">'+(p.edge!=null?pct(p.edge):'-')+'</td>'+
    '<td class="negative">'+(p.feeImpact!=null?pct(p.feeImpact):'-')+'</td>'+
    '<td class="positive">'+(p.netEdge!=null?pct(p.netEdge):'-')+'</td>'+
    '<td class="'+cls(p.realizedPnlUsd)+'">$'+fmt(p.realizedPnlUsd)+'</td>'+
    '<td class="'+cls(p.returnPct)+'">'+(p.returnPct!=null?pct(p.returnPct):'-')+'</td>'+
    '</tr>';
    var reasoningRow='<tr class="reasoning-row" id="closed-'+idx+'" style="display:none"><td colspan="10">'+
    '<div class="reasoning-content">'+
    '<span class="reasoning-label">'+t('reasoning')+'</span>'+
    (p.confidence?'<span class="confidence-badge confidence-'+p.confidence+'">'+esc(p.confidence)+'</span>':'')+
    '<div class="reasoning-text">'+(p.reasoningSummary?esc(p.reasoningSummary):'<em>'+t('noReasoning')+'</em>')+'</div>'+
    (p.keyEvidence&&p.keyEvidence.length?'<div class="evidence-list"><strong>'+t('evidence')+':</strong><ul>'+p.keyEvidence.map(function(e){return '<li>'+esc(e)+'</li>'}).join('')+'</ul></div>':'')+
    '</div></td></tr>';
    return mainRow+reasoningRow;
  }).join('');
}

function toggleReasoning(id){
  var row=document.getElementById(id);
  if(!row)return;
  var isHidden=row.style.display==='none';
  row.style.display=isHidden?'table-row':'none';
  var icon=document.getElementById('icon-'+id);
  if(icon)icon.style.transform=isHidden?'rotate(90deg)':'';
}

function renderSkipped(items){
  var tbody=document.getElementById('skipped-body');
  if(!items||!items.length){tbody.innerHTML='<tr><td colspan="6" style="color:#8b949e">'+t('noSkipped')+'</td></tr>';return}
  tbody.innerHTML=items.map(function(c){return '<tr>'+
    '<td>'+marketLink(c)+'</td>'+
    '<td>'+(c.category||'-')+'</td>'+
    '<td>$'+fmt(c.liquidityUsd,0)+'</td>'+
    '<td>'+(c.phase||'-')+'</td>'+
    '<td style="white-space:normal;max-width:400px">'+esc(c.reason||'-')+'</td>'+
    '<td>'+ts(c.skippedAt)+'</td>'+
  '</tr>'}).join('');
}

async function refresh(){
  try{
    var res=await fetch('/api/data');
    var data=await res.json();
    _data=data;
    window._data=data;
    renderAll();
    document.getElementById('refresh').textContent=t('lastRefresh')+': '+new Date().toLocaleTimeString();
  }catch(e){
    document.getElementById('refresh').textContent=t('refreshFail')+': '+e.message;
  }
}

document.getElementById('lang-btn').textContent = t('toggleBtn');
renderAll();
refresh();
setInterval(refresh,30000);
</script>
</body>
</html>`;
}
