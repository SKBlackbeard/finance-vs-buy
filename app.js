/* Cash vs finance — vehicle purchase break-even.
 *
 * Framing (as specified):
 *   - Instalments are ALWAYS paid from salary, never from the investment pot.
 *   - Paying cash means liquidating investments / drawing on the bond, so the cash
 *     buyer forgoes growth at the "opportunity cost" rate on the full purchase price.
 *   - The cash buyer's salary is freed from the debit order, and they put that money
 *     back to work at their own (separate) reinvestment rate.
 *   - Compare the two invested positions at the end of the term. The car itself is
 *     owned in both scenarios, so its value and depreciation cancel and are ignored.
 */

const CONFIG = [
  { group: 'The deal', controls: [
    { key:'price',       label:'Vehicle price',    kind:'money', min:50e3, max:3e6,  step:5000, value:600000, hint:p=>money(p.price) },
    { key:'depositPct',  label:'Deposit',          kind:'pct',   min:0,    max:50,   step:1,    value:10, hint:p=>`${money(p.price*p.depositPct/100)} upfront, also out of the pot` },
    { key:'balloonPct',  label:'Balloon / residual',kind:'pct',  min:0,    max:45,   step:1,    value:0,  hint:p=>p.balloonPct?`${money(p.price*p.balloonPct/100)} lump due at month ${p.termMonths}`:'No residual — fully amortised' },
    { key:'termMonths',  label:'Term',             kind:'months',min:12,   max:84,   step:6,    value:60 },
    { key:'financeRate', label:'Finance rate',     kind:'rate',  min:0,    max:25,   step:0.25, value:12, hint:()=>'Nominal annual, compounded monthly' },
    { key:'serviceFee',  label:'Monthly service fee',kind:'money2',min:0,  max:200,  step:1,    value:69, hint:p=>`${money(p.serviceFee*p.termMonths)} over the term — the fixed cost that creates a threshold` },
  ]},
  { group: 'Opportunity cost', controls: [
    { key:'assetRate',   label:'Growth forgone on the lump', kind:'rate', min:0, max:25, step:0.25, value:13, hint:()=>'What the purchase price would have earned, or the bond interest you’d have avoided' },
    { key:'reinvestRate',label:'Reinvestment rate on freed salary', kind:'rate', min:0, max:25, step:0.25, value:13, hint:()=>'Where the cash buyer’s spare instalment goes each month' },
    { key:'taxRate',     label:'Tax on growth', kind:'rate', min:0, max:45, step:1, value:0, hint:p=>p.taxRate?`Both rates cut to ${fmtRate(p.assetRate*(1-p.taxRate/100))} and ${fmtRate(p.reinvestRate*(1-p.taxRate/100))} net`:'0% — untaxed, e.g. a bond drawdown' },
  ]},
];

const state = {};
CONFIG.forEach(g => g.controls.forEach(c => { state[c.key] = c.value; }));
state.compounding = 'annual';   // 'annual' | 'monthly' — how the growth rates compound

/* ---------- formatting ---------- */
const zar = new Intl.NumberFormat('en-ZA', { style:'currency', currency:'ZAR', maximumFractionDigits:0 });
const money  = v => zar.format(Math.round(v));
const money2 = v => new Intl.NumberFormat('en-ZA',{style:'currency',currency:'ZAR',minimumFractionDigits:2,maximumFractionDigits:2}).format(v);
const fmtRate = v => `${(Math.round(v*100)/100).toString()}%`;
function compact(v){
  const a = Math.abs(v), s = v < 0 ? '−' : '';
  if (a >= 1e6) return `${s}R${(a/1e6).toFixed(a >= 1e7 ? 0 : 1)}m`;
  if (a >= 1e3) return `${s}R${Math.round(a/1e3)}k`;
  return `${s}R${Math.round(a)}`;
}

/* ---------- model ---------- */
function monthlyRate(annualPct, mode){
  const g = annualPct / 100;
  return mode === 'annual' ? Math.pow(1 + g, 1/12) - 1 : g / 12;
}
const fv = (pmt, r, n) => r === 0 ? pmt * n : pmt * (Math.pow(1 + r, n) - 1) / r;

function model(s, price){
  const P = price;
  const N = Math.round(s.termMonths);
  const D = P * s.depositPct / 100;
  const B = P * s.balloonPct / 100;
  const L = P - D;                       // financed
  const i = s.financeRate / 100 / 12;    // nominal annual, compounded monthly

  // Instalment amortising L down to the balloon B over N months.
  let instalment;
  if (i === 0) instalment = (L - B) / N;
  else { const d = Math.pow(1 + i, -N); instalment = (L - B * d) * i / (1 - d); }

  const outflow = instalment + s.serviceFee;   // what leaves salary each month
  const ma = monthlyRate(s.assetRate    * (1 - s.taxRate/100), s.compounding);
  const mr = monthlyRate(s.reinvestRate * (1 - s.taxRate/100), s.compounding);

  // Finance: keep (P − D) invested; settle the balloon at month N.
  // Cash: pot starts at zero, fed by the freed instalment each month.
  const financeAt = m => (P - D) * Math.pow(1 + ma, m) - (m >= N ? B : 0);
  const cashAt    = m => fv(outflow, mr, m);

  const financeEnd = financeAt(N), cashEnd = cashAt(N);
  return {
    P, N, D, B, instalment, outflow, financeAt, cashAt, financeEnd, cashEnd,
    net: financeEnd - cashEnd,
    totalToBank: outflow * N + D + B,
    totalInterest: outflow * N + D + B - P,
  };
}

// net(price) is exactly affine in price, so two samples pin the line down.
function breakEven(s){
  const a = model(s, 1e6).net, b = model(s, 2e6).net;
  const slope = (b - a) / 1e6;
  const intercept = a - slope * 1e6;
  if (Math.abs(slope) < 1e-12) return { slope, price:null, reason:'flat' };
  const price = -intercept / slope;
  if (slope < 0) return { slope, price: price > 0 ? price : null, reason:'inverted' };
  return { slope, price: price > 0 ? price : 0, reason:'normal' };
}

/* ---------- generic SVG line chart ---------- */
function css(n){ return getComputedStyle(document.body).getPropertyValue(n).trim(); }

function niceTicks(min, max, count){
  const span = (max - min) || 1;
  const mag = Math.pow(10, Math.floor(Math.log10(span / count)));
  const norm = span / count / mag;
  const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
  const out = [];
  for (let v = Math.ceil(min/step)*step; v <= max + step*1e-9; v += step) out.push(Math.abs(v) < step*1e-9 ? 0 : v);
  return out;
}

const NS = 'http://www.w3.org/2000/svg';
const el = (tag, attrs) => { const n = document.createElementNS(NS, tag); for (const k in attrs) n.setAttribute(k, attrs[k]); return n; };

function drawChart(svg, spec){
  const W = svg.parentNode.clientWidth || 700;
  const H = spec.height || 270;
  const M = { t:14, r:18, b:34, l:58 };
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('height', H);
  while (svg.firstChild) svg.removeChild(svg.firstChild);

  const iw = W - M.l - M.r, ih = H - M.t - M.b;
  const allY = spec.series.flatMap(s => s.pts.map(p => p[1])).concat(spec.includeZero ? [0] : []);
  let y0 = Math.min(...allY), y1 = Math.max(...allY);
  if (y1 - y0 < 1e-9) { y1 = y0 + 1; }
  const pad = (y1 - y0) * 0.08; y0 -= pad; y1 += pad;
  const [x0, x1] = spec.xDomain;

  const X = v => M.l + (v - x0) / (x1 - x0) * iw;
  const Y = v => M.t + ih - (v - y0) / (y1 - y0) * ih;

  const gridC = css('--grid'), muted = css('--text-muted'), sec = css('--text-secondary');

  // grid + y axis
  for (const t of niceTicks(y0, y1, 5)){
    svg.appendChild(el('line', { x1:M.l, x2:M.l+iw, y1:Y(t), y2:Y(t), stroke:gridC, 'stroke-width':1 }));
    const lb = el('text', { x:M.l-9, y:Y(t)+4, 'text-anchor':'end', fill:muted, 'font-size':11 });
    lb.textContent = spec.yFmt(t); svg.appendChild(lb);
  }
  // x axis: a tick every xTickStep, labelled as densely as the width allows
  const xs = [];
  for (let v = Math.ceil(x0/spec.xTickStep)*spec.xTickStep; v <= x1 + spec.xTickStep*1e-9; v += spec.xTickStep) xs.push(v);
  const endsOnTick = Math.abs(xs[xs.length-1] - x1) < spec.xTickStep*1e-9;
  if (!endsOnTick) xs.push(x1);                       // always anchor the far end
  const pxPerTick = iw / ((x1 - x0) / spec.xTickStep);
  const need = Math.ceil((spec.xLabelMinPx || 44) / pxPerTick);
  // snap the label stride to a round multiple of the step so labels land on round numbers
  const stride = [1,2,4,5,10,20,40,50,100,200].find(v => v >= need) || need;
  xs.forEach((t, k) => {
    const isEnd = !endsOnTick && k === xs.length - 1;
    // label every stride-th tick; the far end always wins, and eats a neighbour that is too close
    let labelled = isEnd || (k % stride === 0);
    if (labelled && !isEnd && !endsOnTick && (x1 - t) / spec.xTickStep * pxPerTick < (spec.xLabelMinPx || 44)) labelled = false;
    svg.appendChild(el('line', {
      x1:X(t), x2:X(t), y1:M.t, y2:M.t + ih,
      stroke:gridC, 'stroke-width':1, opacity: labelled ? 1 : 0.45,
    }));
    svg.appendChild(el('line', { x1:X(t), x2:X(t), y1:M.t+ih, y2:M.t+ih+(labelled?4:2.5), stroke:css('--border-strong'), 'stroke-width':1 }));
    if (!labelled) return;
    const lb = el('text', { x:X(t), y:H-12, 'text-anchor':'middle', fill:muted, 'font-size':11 });
    lb.textContent = spec.xFmt(t); svg.appendChild(lb);
  });

  // zero line
  if (spec.includeZero && y0 < 0 && y1 > 0)
    svg.appendChild(el('line', { x1:M.l, x2:M.l+iw, y1:Y(0), y2:Y(0), stroke:css('--border-strong'), 'stroke-width':1.5 }));

  // signed areas (net-benefit chart)
  if (spec.signedArea){
    const s = spec.series[0];
    const d = s.pts.map((p,k) => `${k?'L':'M'}${X(p[0])},${Y(p[1])}`).join('') +
              `L${X(s.pts[s.pts.length-1][0])},${Y(0)}L${X(s.pts[0][0])},${Y(0)}Z`;
    const defs = el('defs', {});
    [['clipPos', M.t, Math.max(0, Y(0)-M.t)], ['clipNeg', Y(0), Math.max(0, M.t+ih-Y(0))]].forEach(([id,ty,hh]) => {
      const cp = el('clipPath', { id });
      cp.appendChild(el('rect', { x:M.l, y:ty, width:iw, height:hh }));
      defs.appendChild(cp);
    });
    svg.appendChild(defs);
    svg.appendChild(el('path', { d, fill:css('--finance'), 'fill-opacity':.17, 'clip-path':'url(#clipPos)' }));
    svg.appendChild(el('path', { d, fill:css('--cash'),    'fill-opacity':.17, 'clip-path':'url(#clipNeg)' }));
  }

  // vertical markers
  (spec.markers || []).forEach((m, mi) => {
    if (m.x < x0 || m.x > x1) return;
    svg.appendChild(el('line', { x1:X(m.x), x2:X(m.x), y1:M.t, y2:M.t+ih, stroke:m.color, 'stroke-width':1.5, 'stroke-dasharray':'4 4' }));
    const lb = el('text', { x:X(m.x) + (m.anchor === 'end' ? -7 : 7), y:M.t + 12 + mi*15, 'text-anchor':m.anchor || 'start', fill:m.color, 'font-size':11, 'font-weight':600 });
    lb.textContent = m.label; svg.appendChild(lb);
  });

  // lines
  for (const s of spec.series){
    svg.appendChild(el('path', {
      d: s.pts.map((p,k) => `${k?'L':'M'}${X(p[0])},${Y(p[1])}`).join(''),
      fill:'none', stroke:s.color, 'stroke-width':2, 'stroke-linejoin':'round', 'stroke-linecap':'round',
    }));
  }

  // hover layer
  const cross = el('line', { y1:M.t, y2:M.t+ih, stroke:sec, 'stroke-width':1, 'stroke-dasharray':'3 3', opacity:0 });
  svg.appendChild(cross);
  const dots = spec.series.map(s => {
    const c = el('circle', { r:4.5, fill:s.color, stroke:css('--surface-1'), 'stroke-width':2, opacity:0 });
    svg.appendChild(c); return c;
  });
  const hit = el('rect', { x:M.l, y:M.t, width:iw, height:ih, fill:'transparent' });
  svg.appendChild(hit);

  const tip = spec.tip;
  const n = spec.series[0].pts.length;
  hit.addEventListener('mousemove', ev => {
    const r = svg.getBoundingClientRect();
    const px = (ev.clientX - r.left) * (W / r.width);
    const k = Math.max(0, Math.min(n-1, Math.round((px - M.l) / iw * (n-1))));
    const xv = spec.series[0].pts[k][0];
    cross.setAttribute('x1', X(xv)); cross.setAttribute('x2', X(xv)); cross.setAttribute('opacity', 1);
    spec.series.forEach((s, si) => {
      dots[si].setAttribute('cx', X(xv)); dots[si].setAttribute('cy', Y(s.pts[k][1])); dots[si].setAttribute('opacity', 1);
    });
    tip.innerHTML = spec.tipHtml(k, xv);
    tip.style.opacity = 1;
    const left = X(xv) / W * r.width;
    tip.style.left = `${Math.min(Math.max(left - tip.offsetWidth/2, 4), r.width - tip.offsetWidth - 4)}px`;
    tip.style.top = '6px';
  });
  hit.addEventListener('mouseleave', () => {
    cross.setAttribute('opacity', 0); dots.forEach(d => d.setAttribute('opacity', 0)); tip.style.opacity = 0;
  });
}

const tipRow = (color, k, v) =>
  `<div class="tip-row"><span class="k">${color ? `<i class="swatch" style="background:${color}"></i>` : ''}${k}</span><span class="v">${v}</span></div>`;

/* ---------- render ---------- */
function renderVerdict(m, be){
  const host = document.getElementById('verdict');
  if (be.reason === 'flat' || (be.slope <= 0)){
    const why = `At ${fmtRate(state.assetRate)} growth against a ${fmtRate(state.financeRate)} finance rate, the borrowing costs more than the capital earns. There is no price at which financing wins — the gap only widens as the car gets more expensive.`;
    host.innerHTML = `<span class="pill cash">Cash wins at every price</span>
      <p class="hero na">No break-even</p><p class="verdict-note">${why}</p>`;
    return;
  }
  const Y = be.price;
  const above = m.P >= Y;
  const gap = Math.abs(m.net);
  host.innerHTML = `
    <span class="pill ${above ? 'fin' : 'cash'}">${above ? 'Finance this one' : 'Pay cash for this one'}</span>
    <p class="headline">Break-even vehicle price</p>
    <p class="hero">${Y <= 0 ? 'Every price' : money(Y)}</p>
    <p class="verdict-note">
      ${Y <= 0
        ? `With no fixed monthly fee there is no threshold — financing wins at any price, because ${fmtRate(state.assetRate)} growth beats the ${fmtRate(state.financeRate)} finance rate.`
        : `Above ${money(Y)}, financing leaves you better off; below it the ${money2(state.serviceFee)}/month service fee outweighs the rate advantage.`}
      At ${money(m.P)} you end the ${m.N} months <strong>${money(gap)} ${above ? 'ahead by financing' : 'ahead by paying cash'}</strong>.
    </p>`;
}

function renderPriceChart(m, be){
  const svg = document.getElementById('priceChart');
  const STEP = 50e3;
  const hi = Math.ceil(Math.max(m.P * 2, (be.price || 0) * 2, 400e3) / STEP) * STEP;
  const pts = [];
  for (let k = 0; k <= 140; k++){
    const p = hi * k / 140;
    pts.push([p, p === 0 ? model(state, 1).net : model(state, p).net]);
  }
  const markers = [{ x:m.P, label:`Your price ${compact(m.P)}`, color:css('--text-secondary'), anchor: m.P > hi*0.7 ? 'end' : 'start' }];
  if (be.price > 0 && be.price < hi)
    markers.push({ x:be.price, label:`Break-even ${compact(be.price)}`, color:css('--finance'), anchor: be.price > hi*0.7 ? 'end' : 'start' });

  drawChart(svg, {
    series: [{ name:'Net', color: css('--text-secondary'), pts }],
    xDomain: [0, hi], includeZero: true, signedArea: true, markers,
    xTickStep: STEP, xLabelMinPx: 46, xFmt: compact, yFmt: compact,
    tip: document.getElementById('priceTip'),
    tipHtml: (k) => {
      const p = pts[k][0], v = pts[k][1];
      return `<div class="tip-h">${money(p)} vehicle</div>` +
        tipRow(v >= 0 ? css('--finance') : css('--cash'), v >= 0 ? 'Finance ahead by' : 'Cash ahead by', money(Math.abs(v)));
    },
  });
}

function renderTimeChart(m){
  const fin = [], cash = [];
  for (let mo = 0; mo <= m.N; mo++){ fin.push([mo, m.financeAt(mo)]); cash.push([mo, m.cashAt(mo)]); }
  drawChart(document.getElementById('timeChart'), {
    series: [
      { name:'Finance', color: css('--finance'), pts: fin },
      { name:'Cash',    color: css('--cash'),    pts: cash },
    ],
    xDomain: [0, m.N], includeZero: true,
    xTickStep: 4, xLabelMinPx: 24, xFmt: v => `${Math.round(v)}`, yFmt: compact,
    tip: document.getElementById('timeTip'),
    tipHtml: (k) => {
      const d = fin[k][1] - cash[k][1];
      return `<div class="tip-h">Month ${k}</div>` +
        tipRow(css('--finance'), 'Finance', money(fin[k][1])) +
        tipRow(css('--cash'), 'Cash', money(cash[k][1])) +
        `<div class="tip-sep"></div>` +
        tipRow(null, d >= 0 ? 'Finance ahead' : 'Cash ahead', money(Math.abs(d)));
    },
  });
}

function renderNumbers(m){
  const rows = [
    ['Monthly instalment', money2(m.instalment), ''],
    ['Service fee', money2(state.serviceFee), ''],
    ['Total monthly debit order', money2(m.outflow), 'strong'],
    ['Deposit paid upfront', money(m.D), ''],
    ['Balloon settled at month ' + m.N, money(m.B), ''],
    ['Total paid to the bank', money(m.totalToBank), ''],
    ['Of which is interest &amp; fees', money(m.totalInterest), ''],
  ];
  document.getElementById('numbers').innerHTML = `
    <table>
      <tbody>${rows.map(r => `<tr><td>${r[0]}</td><td colspan="2">${r[1]}</td></tr>`).join('')}</tbody>
    </table>
    <table style="margin-top:2px">
      <thead><tr><th>At month ${m.N}</th><th>Finance</th><th>Cash</th></tr></thead>
      <tbody>
        <tr><td>Invested position</td><td class="fin">${money(m.financeEnd)}</td><td class="cash">${money(m.cashEnd)}</td></tr>
        <tr><td>Difference</td><td colspan="2" class="${m.net >= 0 ? 'fin' : 'cash'}">${money(Math.abs(m.net))} better off ${m.net >= 0 ? 'financing' : 'paying cash'}</td></tr>
      </tbody>
    </table>`;
}

function render(){
  const m = model(state, state.price);
  const be = breakEven(state);
  renderVerdict(m, be);
  renderPriceChart(m, be);
  renderTimeChart(m);
  renderNumbers(m);
  for (const h of hintFns) h();
}

/* ---------- controls ---------- */
const hintFns = [];
function buildControls(){
  const body = document.querySelector('#controls .panel-body');
  const frag = document.createDocumentFragment();

  for (const g of CONFIG){
    const wrap = document.createElement('div');
    wrap.className = 'group';
    wrap.innerHTML = `<div class="group-label">${g.group}</div>`;
    for (const c of g.controls){
      const row = document.createElement('div');
      row.className = 'ctl';
      const suffix = c.kind === 'rate' ? '% p.a.' : c.kind === 'pct' ? '%' : c.kind === 'months' ? 'months' : 'R';
      row.innerHTML = `
        <div class="ctl-top">
          <label class="ctl-label" for="i-${c.key}">${c.label}</label>
          <input type="number" id="i-${c.key}" min="${c.min}" max="${c.max}" step="${c.step}" value="${c.value}">
        </div>
        <input type="range" id="r-${c.key}" min="${c.min}" max="${c.max}" step="${c.step}" value="${c.value}" aria-label="${c.label}">
        <div class="ctl-hint" id="h-${c.key}">${suffix === 'R' ? '' : suffix}</div>`;
      wrap.appendChild(row);

      const num = row.querySelector('input[type=number]');
      const rng = row.querySelector('input[type=range]');
      const hint = row.querySelector('.ctl-hint');

      const set = (v, from) => {
        v = Math.min(c.max, Math.max(c.min, Number(v)));
        if (!Number.isFinite(v)) return;
        state[c.key] = v;
        if (from !== 'num') num.value = v;
        if (from !== 'rng') rng.value = v;
        render();
      };
      num.addEventListener('input', e => set(e.target.value, 'num'));
      rng.addEventListener('input', e => set(e.target.value, 'rng'));
      if (c.hint) hintFns.push(() => { hint.textContent = c.hint(state); });
    }
    frag.appendChild(wrap);
  }

  // compounding toggle
  const wrap = document.createElement('div');
  wrap.className = 'group';
  wrap.innerHTML = `<div class="group-label">Compounding</div>
    <div class="ctl">
      <div class="ctl-top"><span class="ctl-label">Growth rates compound</span></div>
      <div class="seg" role="group">
        <button type="button" data-v="annual"  aria-pressed="true">Annually</button>
        <button type="button" data-v="monthly" aria-pressed="false">Monthly</button>
      </div>
      <div class="ctl-hint">Effective annual rate, converted to a monthly equivalent. The finance rate is always nominal-annual compounded monthly.</div>
    </div>`;
  wrap.querySelectorAll('.seg button').forEach(b => b.addEventListener('click', () => {
    state.compounding = b.dataset.v;
    wrap.querySelectorAll('.seg button').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
    wrap.querySelector('.ctl-hint').textContent = state.compounding === 'annual'
      ? 'Effective annual rate, converted to a monthly equivalent. The finance rate is always nominal-annual compounded monthly.'
      : 'Nominal annual rate divided by 12. The finance rate is always nominal-annual compounded monthly.';
    render();
  }));
  frag.appendChild(wrap);

  body.appendChild(frag);
}

buildControls();
render();
addEventListener('resize', render);
if (matchMedia) matchMedia('(prefers-color-scheme: dark)').addEventListener('change', render);
