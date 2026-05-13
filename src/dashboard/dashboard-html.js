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
.refresh{color:#8b949e;font-size:0.75em;margin-top:8px}
@media(max-width:600px){.summary{grid-template-columns:1fr 1fr}td,th{padding:4px 3px;font-size:0.78em}}
</style>
</head>
<body>
<h1>PolyPulse Monitor</h1>
<div class="meta" id="meta">Loading...</div>

<div class="summary" id="summary"></div>

<h2>Open Positions</h2>
<div style="overflow-x:auto"><table id="open-table"><thead><tr>
<th>Topic ID</th><th>Content</th><th>Side</th><th>Open Time</th><th>Expiry</th><th>Amount</th><th>AI Prob</th><th>Mkt Prob</th><th>PnL</th>
</tr></thead><tbody id="open-body"></tbody></table></div>

<h2>Closed Positions</h2>
<div style="overflow-x:auto"><table id="closed-table"><thead><tr>
<th>Topic ID</th><th>Content</th><th>Side</th><th>Open Time</th><th>Close Time</th><th>Amount</th><th>PnL</th><th>AI Prob</th><th>Mkt Prob</th><th>Return</th>
</tr></thead><tbody id="closed-body"></tbody></table></div>

<div class="refresh" id="refresh"></div>

<script>
function fmt(n,d){return n==null?'-':Number(n).toFixed(d??2)}
function pct(n){return n==null?'-':(Number(n)*100).toFixed(2)+'%'}
function ts(s){if(!s)return'-';const d=new Date(s);return d.toLocaleDateString('zh-CN')+' '+d.toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'})}
function cls(n){return n>0?'positive':n<0?'negative':''}

function renderSummary(s){
  const items=[
    ['Start Time',ts(window._data?.startedAt)],
    ['Running Days',fmt(s.elapsedDays,1)+' days'],
    ['Initial Fund','$'+fmt(s.initialCashUsd)],
    ['Cash','$'+fmt(s.cashUsd)],
    ['Equity','$'+fmt(s.totalEquityUsd)],
    ['Unrealized PnL','$'+fmt(s.unrealizedPnlUsd),cls(s.unrealizedPnlUsd)],
    ['Realized PnL','$'+fmt(s.realizedPnlUsd),cls(s.realizedPnlUsd)],
    ['Monthly Return',pct(s.monthlyReturnPct),cls(s.monthlyReturnPct)],
    ['Annual Return',pct(s.annualReturnPct),cls(s.annualReturnPct)],
    ['Win Rate',s.winRate!=null?pct(s.winRate):'-'],
    ['W/L',s.wins+'/'+s.losses],
    ['Max Drawdown','$'+fmt(s.maxDrawdownUsd),'negative']
  ];
  document.getElementById('summary').innerHTML=items.map(([l,v,c])=>
    '<div class="card"><div class="label">'+l+'</div><div class="value '+(c||'')+'">'+v+'</div></div>'
  ).join('');
}

function renderOpen(positions){
  const tbody=document.getElementById('open-body');
  if(!positions.length){tbody.innerHTML='<tr><td colspan="9" style="color:#8b949e">No open positions</td></tr>';return}
  tbody.innerHTML=positions.map(p=>'<tr>'+
    '<td>'+((p.marketId||'').slice(0,8))+'</td>'+
    '<td title="'+(p.question||'').replace(/"/g,'&quot;')+'">'+(p.question||'-')+'</td>'+
    '<td>'+(p.outcome||'-')+'</td>'+
    '<td>'+ts(p.openedAt)+'</td>'+
    '<td>'+ts(p.endDate)+'</td>'+
    '<td>$'+fmt(p.costUsd)+'</td>'+
    '<td>'+(p.aiProbability!=null?pct(p.aiProbability):'-')+'</td>'+
    '<td>'+(p.marketProbability!=null?pct(p.marketProbability):'-')+'</td>'+
    '<td class="'+cls(p.unrealizedPnlUsd)+'">$'+fmt(p.unrealizedPnlUsd)+'</td>'+
  '</tr>').join('');
}

function renderClosed(trades){
  const tbody=document.getElementById('closed-body');
  if(!trades.length){tbody.innerHTML='<tr><td colspan="10" style="color:#8b949e">No closed positions</td></tr>';return}
  tbody.innerHTML=trades.map(t=>'<tr>'+
    '<td>'+((t.marketId||'').slice(0,8))+'</td>'+
    '<td title="'+(t.question||'').replace(/"/g,'&quot;')+'">'+(t.question||'-')+'</td>'+
    '<td>'+(t.outcome||'-')+'</td>'+
    '<td>'+ts(t.openedAt)+'</td>'+
    '<td>'+ts(t.closedAt)+'</td>'+
    '<td>$'+fmt(t.costUsd)+'</td>'+
    '<td class="'+cls(t.realizedPnlUsd)+'">$'+fmt(t.realizedPnlUsd)+'</td>'+
    '<td>'+(t.aiProbability!=null?pct(t.aiProbability):'-')+'</td>'+
    '<td>'+(t.marketProbability!=null?pct(t.marketProbability):'-')+'</td>'+
    '<td class="'+cls(t.returnPct)+'">'+(t.returnPct!=null?pct(t.returnPct):'-')+'</td>'+
  '</tr>').join('');
}

async function refresh(){
  try{
    const res=await fetch('/api/data');
    const data=await res.json();
    window._data=data;
    document.getElementById('meta').textContent=
      'Mode: '+data.executionMode+' | Started: '+ts(data.startedAt);
    renderSummary(data.summary||{});
    renderOpen(data.openPositions||[]);
    renderClosed(data.closedPositions||[]);
    document.getElementById('refresh').textContent='Last refresh: '+new Date().toLocaleTimeString();
  }catch(e){
    document.getElementById('refresh').textContent='Refresh failed: '+e.message;
  }
}
refresh();
setInterval(refresh,30000);
</script>
</body>
</html>`;
}
