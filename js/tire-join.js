/* /join on tires.whollar.ca: the two sign-up paths and the four calculators.
 *
 * Lifted verbatim from the waitlist prototype by scripts/port-tires.mjs, with
 * three demo behaviours removed and the landing page's handoff added. Edit the
 * prototype or the port script, not this file: it is generated.
 *
 * WHAT WAS REMOVED, AND WHY. The prototype fabricated three things, honestly
 * labelled as a prototype but not shippable:
 *   1. the rank, "you are #1,848 in the GTA cohort", which was 1847 plus a
 *      random number, a claim about how many households joined,
 *   2. the reference code, minted in the browser from Math.random, so two
 *      people could hold the same one and nothing could be looked up by it,
 *   3. "We just emailed it to you", said when no email was sent.
 *
 * THE FORM DOES NOT SAVE YET. POST /tire-waitlist-join and the three tables
 * behind it are specified in docs/TIRE_VERTICAL_BUILD.md and do not exist. So
 * this submits nothing and says nothing about having saved anything. The
 * calculators are fully working: they run entirely here.
 */
(function(){
  var F={path:null,stage:1,strategy:'winter',fields:{}};
  var $=function(s,r){return (r||document).querySelector(s)};
  var $$=function(s,r){return Array.prototype.slice.call((r||document).querySelectorAll(s))};

  function show(id){$$('.screen').forEach(function(s){s.classList.toggle('on',s.id===id)});window.scrollTo({top:0,behavior:'smooth'})}

  /* path choice */
  $$('.pathcard').forEach(function(b){b.addEventListener('click',function(){
    F.path=b.dataset.go;
    if(F.path==='quick') show('s-quick'); else {gStage(1);show('s-guided');}
  })});
  $$('[data-back]').forEach(function(b){b.addEventListener('click',function(){show('s-'+b.dataset.back)})});

  /* populate year/make selects */
  function fillVeh(ySel,mSel){
    for(var y=2026;y>=2008;y--){var o=document.createElement('option');o.value=y;o.textContent=y;ySel.appendChild(o);}
    ['Toyota','Honda','Ford','Chevrolet','Hyundai','Kia','Nissan','Mazda','Volkswagen','Subaru','BMW','Mercedes-Benz','Audi','Jeep','Ram','GMC','Dodge','Tesla','Lexus','Acura','Volvo','Mitsubishi','Chrysler','Buick','Cadillac','Land Rover','Porsche','Other'].forEach(function(m){var o=document.createElement('option');o.value=m;o.textContent=m;mSel.appendChild(o);});
  }
  $$('.qyear').forEach(function(y){fillVeh(y,$('.qmake'))});
  $$('.gyear').forEach(function(y){fillVeh(y,$('.gmake'))});

  /* seg toggles */
  $$('[data-seg]').forEach(function(seg){
    seg.addEventListener('click',function(e){var b=e.target.closest('button');if(!b)return;
      seg.querySelectorAll('button').forEach(function(x){x.classList.toggle('on',x===b)});
      var scope=seg.closest('.field');
      scope.querySelectorAll('[data-pane]').forEach(function(p){p.hidden=p.dataset.pane!==b.dataset.mode});
    });
  });

  /* chips (single + multi) */
  $$('[data-chips]').forEach(function(group){
    var multi=group.dataset.multi==='1';
    group.addEventListener('click',function(e){var b=e.target.closest('.chip');if(!b)return;
      if(multi){b.classList.toggle('on')} else {group.querySelectorAll('.chip').forEach(function(x){x.classList.toggle('on',x===b)})}
      F.fields[group.dataset.chips]=$$('.chip.on',group).map(function(x){return x.dataset.v});
    });
  });
  function chosen(name){return F.fields[name]||[]}

  /* helper open toggles */
  $$('[data-helper]').forEach(function(b){b.addEventListener('click',function(){
    var el=$('#h-'+b.dataset.helper); if(el){el.hidden=!el.hidden; if(!el.hidden) el.scrollIntoView({behavior:'smooth',block:'nearest'});}
  })});

  /* ---------- calculators ---------- */
  function money(n){return '$'+Math.round(n).toLocaleString()}

  /* Helper A: insurance */
  $('#ins-run').addEventListener('click',function(){
    var prem=parseFloat($('#ins-prem').value)||0, co=$('#ins-co').value;
    if(!prem){$('#ins-prem').focus();return;}
    var lo=0.02, hi=0.05, note='Range shown because insurers differ.';
    if(co==='caa'){lo=0.05;hi=0.05;note='CAA states all four snowflake-marked tires qualify for their 5% discount.';}
    var yrs=6, set=900;
    var aLo=prem*lo, aHi=prem*hi, lLo=aLo*yrs, lHi=aHi*yrs;
    var offLo=Math.round(lLo/set*100), offHi=Math.round(lHi/set*100);
    var out=$('#ins-out');
    out.innerHTML='<div class="big">'+money(aLo)+(aHi>aLo?' to '+money(aHi):'')+' / year</div>'
      +'About '+money(lLo)+(lHi>lLo?' to '+money(lHi):'')+' over the 6-year life of a set. '
      +'That offsets roughly '+offLo+(offHi>offLo?' to '+offHi:'')+'% of a typical set.'
      +'<div class="caveat">'+note+' Estimate only. Qualifying needs four 3PMSF winter tires, usually on by Nov 1, and you must tell your insurer. Some insurers do not grant the discount for all-weather tires, so confirm with yours.</div>';
    out.hidden=false;
  });

  /* Helper B: size options */
  function parseSize(s){var m=(s||'').replace(/\s/g,'').match(/(\d{3})\/(\d{2})R?(\d{2})/i);if(!m)return null;return{w:+m[1],a:+m[2],r:+m[3]}}
  function od(w,a,r){return r*25.4+2*(w*a/100)}
  function bestAspect(targetOD,w,r){return Math.round(((targetOD-r*25.4)/2/w*100)/5)*5}
  $('#sz-run').addEventListener('click',function(){
    var p=parseSize($('#sz-in').value); var out=$('#sz-out');
    if(!p){out.innerHTML='<b>Hmm, that does not look like a tire size.</b><div class="caveat">Try the format 225/45R17.</div>';out.hidden=false;return;}
    var base=od(p.w,p.a,p.r);
    function row(w,r,tag,dir){
      var a=bestAspect(base,w,r); if(a<25)a=25; if(a>80)a=80;
      var newOD=od(w,a,r); var delta=(newOD/base-1)*100;
      var actual=(100*newOD/base);
      var within=Math.abs(delta)<=3;
      return '<button type="button" class="alt'+(tag==='OE'?' on':'')+'"><span><span class="sz">'+w+'/'+a+'R'+r+'</span>'+(tag?' <span class="tag">'+tag+'</span>':'')+'</span>'
        +'<span class="meta">'+(delta>=0?'+':'')+delta.toFixed(1)+'% diameter · at 100 shown, really ~'+actual.toFixed(0)+' km/h'
        +'<br>'+dir+(within?'':' · outside \u00b13%')+'</span></button>';
    }
    out.innerHTML='<div style="font-weight:750;margin-bottom:8px">Options that keep your speedometer close:</div><div class="altsizes">'
      + row(p.w,p.r,'Your size (OE)','same price baseline')
      + row(p.w-10,p.r-1,'Winter downsize','usually cheaper, better in snow')
      + row(p.w+10,p.r+1,'Upsize','usually pricier, not ideal for winter')
      + '</div><div class="caveat">Winter downsizing uses a smaller wheel and a narrower, taller tire: it bites through snow better and usually costs less. Keep load rating at or above your original. Final fitment is confirmed against your exact car and by your installer.</div>';
    out.hidden=false;
  });

  /* Helper C: rims */
  $('#rc-run').addEventListener('click',function(){
    var tpms=(chosen('rc-tpms')[0]||'na'), years=+(chosen('rc-years')[0]||6), diy=(chosen('rc-diy')[0]==='diy');
    var rims=360, sensors=(tpms==='yes'?280:(tpms==='na'?280:0));
    var upfront=rims+sensors;
    var annualA=160, annualB=diy?0:80;
    var save=annualA-annualB, be=save>0?upfront/save:99, net6=annualA*6-(upfront+annualB*6);
    var twoWins = diy || years>=Math.ceil(be);
    var out=$('#rc-out');
    out.innerHTML='<div class="big">'+money(upfront)+' upfront</div>'
      +'for a second set of steel rims'+(sensors?' plus TPMS sensors':'')+'. It saves about '+money(save)+' a year in changeover fees'+(diy?' (you swap them yourself)':'')+'.'
      +'<br>Break-even in about '+ (save>0?be.toFixed(1)+' years':'n/a') +'. Over 6 years you would '+(net6>=0?'save '+money(net6):'spend '+money(-net6)+' more')+' with two sets.'
      +'<div class="rec">'+(twoWins?'Suggestion: two sets. Faster swaps, less tire wear, and it pays off over the time you will keep them.':'Suggestion: one set is fine for your situation. Keep it simple and swap seasonally.')+'</div>'
      +'<div class="caveat">GTA ballpark costs, refined by your cohort\u2019s real quotes. A second set on a TPMS car needs its own sensors, which is the main upfront cost.</div>';
    out.hidden=false;
  });

  /* Helper D: strategy */
  $('#sd-run').addEventListener('click',function(){
    var life=chosen('sd-life')[0], own=+(chosen('sd-own')[0]||6), drive=chosen('sd-drive')[0], store=chosen('sd-store')[0];
    var score=0; // + toward all-weather
    if(life==='end')score+=2; if(life==='mid')score+=1;
    if(own<=4)score+=2; else if(own<=5)score+=1; else score-=1;
    if(drive==='city')score+=2; else if(drive==='heavy')score-=2;
    if(store==='no')score+=1;
    var allw=score>=3;
    F.strategy=allw?'allweather':'winter';
    applyStrategy();
    var out=$('#sd-out');
    if(allw){
      out.innerHTML='<div class="big">All-weather looks smart for you</div>'
        +'One year-round set, no second rims, no seasonal swaps, no storage. It costs a bit more per set and will not match a dedicated winter tire in deep snow, but for your driving and how long you will keep the car, it is the simpler, often cheaper path.'
        +'<div class="caveat">Insurance: all-weather tires carry the snowflake, but only some insurers grant the discount for them, many require a dedicated set. Confirm with your insurer before relying on it.</div>';
    }else{
      out.innerHTML='<div class="big">Dedicated winter tires look right</div>'
        +'Best grip when it counts, and over the time you will keep the car the second set of rims and the longer life of tires that only run half the year pay off. The insurance discount is reliably available.'
        +'<div class="caveat">You can still switch to all-weather anytime, this is only a suggestion.</div>';
    }
    out.hidden=false;
  });

  function applyStrategy(){
    var allw=F.strategy==='allweather';
    $$('.wblock').forEach(function(el){el.hidden=allw});
    var banner=$('#strategy-banner');
    banner.hidden=false;
    banner.className='reco-banner '+(allw?'allw':'winter');
    banner.innerHTML=allw
      ? '<b>Going with all-weather.</b> We have hidden the rims, swap, and storage questions since a single set does not need them.'
      : '<b>Going with dedicated winters.</b> The rims and storage questions below apply to you.';
  }

  /* install dates */
  var DATES=['Sat Oct 4','Wed Oct 8','Sat Oct 18','Tue Oct 21','Sat Nov 1','Thu Nov 6','Sat Nov 15','Wed Nov 19'];
  var dp=$('#datepick');
  DATES.forEach(function(d){var b=document.createElement('button');b.type='button';b.className='datechip';b.textContent=d;
    b.addEventListener('click',function(){b.classList.toggle('on')});dp.appendChild(b);});

  /* stage machine */
  function gStage(n){F.stage=n;
    $$('.gstage').forEach(function(s){s.hidden=+s.dataset.stage!==n});
    $$('.prog .seg').forEach(function(s){s.classList.toggle('on',+s.dataset.s<=n)});
    $('#proglbl').textContent='Step '+n+' of 3';
    window.scrollTo({top:0,behavior:'smooth'});
  }
  $$('[data-stage-back]').forEach(function(b){b.addEventListener('click',function(){gStage(+b.dataset.stageBack)})});

  function validSimple(form){
    var ok=true;
    $$('[required]',form).forEach(function(el){
      if((el.type==='checkbox'&&!el.checked)||(el.type!=='checkbox'&&!String(el.value).trim())){ok=false;el.classList.add('inp');el.style.borderColor='#B0512B';}
    });
    return ok;
  }

  /* stage 1 -> 2 */
  $('#g1form').addEventListener('submit',function(e){e.preventDefault();
    if(!validSimple(this))return; gStage(2);});
  $('#g2next').addEventListener('click',function(){gStage(3)});

  /* the confirm screen */
  function finish(cityVal){
    /* The server mints the code, and there is no server yet: hide the box
       rather than print a number that means nothing. */
    var refbox=document.querySelector('.refbox'); if(refbox) refbox.style.display='none';
    $('#c-rank').textContent='Your vote is counted. We follow the demand.';
    show('s-confirm');
  }

  /* quick submit */
  $('#quickform').addEventListener('submit',function(e){e.preventDefault();
    if(!validSimple(this))return; finish(this.querySelector('[name=city]').value);});
  /* guided submit */
  $('#g3submit').addEventListener('click',function(){
    var cityVal=(document.querySelector('#s-guided .gstage[data-stage="1"] [name=city]')||{}).value;
    finish(cityVal);});

  $('#addcar').addEventListener('click',function(e){e.preventDefault();show('s-intro');});

  /* ---- arriving from the landing page ----
   * tires.whollar.ca/ links here with the path already chosen, and its four
   * smart-buy cards name the tool they were about. Honour both, so a click on
   * "One set of wheels, or two?" opens that tool rather than dropping someone
   * at the top of a form they did not ask for. */
  try{
    var q=new URLSearchParams(window.location.search);
    var path=q.get('path'), tool=q.get('tool');
    if(path==='quick'){F.path='quick';show('s-quick');}
    else if(path==='guided'){F.path='guided';gStage(tool?2:1);show('s-guided');}
    var TOOLS={strategy:'strategy',size:'size',rims:'rimcalc',insurance:'ins'};
    if(tool&&TOOLS[tool]){
      var panel=$('#h-'+TOOLS[tool]);
      if(panel){panel.hidden=false;setTimeout(function(){panel.scrollIntoView({behavior:'smooth',block:'center'});},260);}
    }
  }catch(e){/* an unparseable query string is not a reason to break the page */}
})();
