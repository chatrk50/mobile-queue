// Builds an Excel workbook (Buffer) from a live dailyReport() object.
// This is a point-in-time SNAPSHOT export, so figures are written as values.
import ExcelJS from 'exceljs';

const NAVY='FF1E3A5F', ACCENT='FF1AB3CE', GREY='FF5C7187', WHITE='FFFFFFFF', BLACK='FF000000';
const BAHT='"฿"#,##0;("฿"#,##0);"-"', BAHT2='"฿"#,##0.00', PCT='0.0%', NUM='#,##0;(#,##0);"-"';
const F='Arial';
const thin={style:'thin',color:{argb:'FFD0D8DF'}};

function C(ws,addr,value,{bold,color,size=10,numFmt,fill,align,bd,italic}={}){
  const c=ws.getCell(addr);
  c.value=value;
  c.font={name:F,size,bold:!!bold,italic:!!italic,color:{argb:color||(fill?WHITE:BLACK)}};
  if(numFmt) c.numFmt=numFmt;
  if(fill) c.fill={type:'pattern',pattern:'solid',fgColor:{argb:fill}};
  c.alignment={vertical:'middle',...(align?{horizontal:align}:{})};
  if(bd) c.border={top:thin,left:thin,bottom:thin,right:thin};
  return c;
}
const hdr=(ws,addr,t)=>C(ws,addr,t,{bold:true,fill:NAVY,align:'center',bd:true});

export async function buildReportWorkbook(r, { store='YO-DEE Yogurt' } = {}){
  const wb=new ExcelJS.Workbook();
  wb.creator=store;
  const p=r.pnl||{}, s=r.settings||{};
  const days=s.daysPerMonth||30;
  const dailyLine=(monthly)=>days>0?monthly/days:monthly;

  // ---------- Report (P&L) ----------
  const rp=wb.addWorksheet('Report',{views:[{showGridLines:false}]});
  rp.columns=[{width:34},{width:16},{width:12}];
  C(rp,'A1',store+' — Daily Report',{bold:true,size:16,color:NAVY});
  C(rp,'A2','Today · resets 00:00 (Bangkok)',{size:11,color:GREY});
  // KPI band
  const kpis=[['Revenue',r.revenue,BAHT],['Gross Profit',p.grossProfit,BAHT],['Net Profit',p.netProfit,BAHT],['Net Margin',p.netMargin,PCT],['Cups',p.cups,NUM]];
  kpis.forEach((k,i)=>{ const col=String.fromCharCode(65+i);
    C(rp,col+'4',k[0],{bold:true,color:WHITE,fill:ACCENT,align:'center',bd:true});
    C(rp,col+'5',k[1]??0,{bold:true,numFmt:k[2],align:'center',bd:true}); });
  // P&L table
  let R=7; hdr(rp,'A'+R,'Income Statement (P&L)'); hdr(rp,'B'+R,'฿'); hdr(rp,'C'+R,'% Rev'); R++;
  const rev=r.revenue||0;
  const line=(label,val,{bold,fill,pct=true}={})=>{ C(rp,'A'+R,label,{bold,fill,color:fill?WHITE:(bold?NAVY:BLACK),bd:true});
    C(rp,'B'+R,val??0,{bold,fill,color:fill?WHITE:BLACK,numFmt:BAHT,align:'right',bd:true});
    C(rp,'C'+R, pct&&rev?((val||0)/rev):'' ,{bold,fill,color:fill?WHITE:GREY,size:9,numFmt:PCT,align:'right',bd:true}); R++; };
  C(rp,'A'+R,'Revenue',{bold:true,color:ACCENT,bd:true});C(rp,'B'+R,'',{bd:true});C(rp,'C'+R,'',{bd:true});R++;
  line('  Drink sales',p.drinkSales);
  line('  Topping add-ons',p.toppingSales);
  line('Total Revenue',rev,{bold:true});
  C(rp,'A'+R,'Cost of Goods Sold',{bold:true,color:ACCENT,bd:true});C(rp,'B'+R,'',{bd:true});C(rp,'C'+R,'',{bd:true});R++;
  line('  Ingredients ('+(s.ingredientPct?(s.ingredientPct*100).toFixed(0):'-')+'% of rev)',p.ingredient);
  line('  Packaging (฿'+(s.packagingPerCup??0)+'/cup)',p.packaging);
  line('Total COGS',p.cogs,{bold:true});
  line('Gross Profit',p.grossProfit,{bold:true,fill:ACCENT});
  C(rp,'A'+R,"Operating Expenses (today's share)",{bold:true,color:ACCENT,bd:true});C(rp,'B'+R,'',{bd:true});C(rp,'C'+R,'',{bd:true});R++;
  const ol=p.opexLines||{};
  line('  Rent / stall fee',dailyLine(ol.rent||0));
  line('  Staff wages',dailyLine(ol.wages||0));
  line('  Utilities',dailyLine(ol.utilities||0));
  line('  Supplies & misc',dailyLine(ol.supplies||0));
  line('  Marketing / LINE',dailyLine(ol.marketing||0));
  line('Total Operating Expenses',p.opexDaily,{bold:true});
  line('NET PROFIT',p.netProfit,{bold:true,fill:NAVY});
  R++;
  C(rp,'A'+R,'Fixed costs prorated from monthly ÷ '+days+' selling days. Avg ฿/cup: '+(p.avgPerCup?p.avgPerCup.toFixed(2):'-'),{italic:true,size:8,color:GREY}); rp.mergeCells('A'+R+':C'+R); R++;
  if(p.targetDaily!=null){ C(rp,'A'+R,'Target (today): ฿'+Math.round(p.targetDaily)+' · variance: ฿'+Math.round(p.revenueVariance||0),{italic:true,size:8,color:GREY}); rp.mergeCells('A'+R+':C'+R); }

  // ---------- Sales (item mix) ----------
  const sl=wb.addWorksheet('Sales',{views:[{showGridLines:false,state:'frozen',ySplit:4}]});
  sl.columns=[{width:6},{width:34},{width:12},{width:10},{width:14},{width:10}];
  C(sl,'A1',store+' — Sales by item',{bold:true,size:16,color:NAVY});
  ['No','Item','Type','Qty','Revenue ฿','% Sales'].forEach((h,i)=>hdr(sl,String.fromCharCode(65+i)+'4',h));
  const items=r.itemSales||[];
  items.forEach((it,i)=>{ const row=5+i;
    C(sl,'A'+row,i+1,{align:'center',bd:true});
    C(sl,'B'+row,it.name,{bd:true});
    C(sl,'C'+row,it.category==='topping'?'topping':'drink',{color:GREY,size:9,bd:true});
    C(sl,'D'+row,it.qty||0,{numFmt:NUM,align:'right',bd:true});
    C(sl,'E'+row,it.revenue||0,{numFmt:BAHT,align:'right',bd:true});
    C(sl,'F'+row,it.pct||0,{numFmt:PCT,align:'right',bd:true});
  });
  const tot=5+items.length;
  C(sl,'B'+tot,'TOTAL',{bold:true,fill:NAVY,color:WHITE});
  C(sl,'C'+tot,'',{fill:NAVY});
  C(sl,'D'+tot,{formula:`SUM(D5:D${tot-1})`,result:items.reduce((a,b)=>a+(b.qty||0),0)},{bold:true,fill:NAVY,color:WHITE,numFmt:NUM,align:'right'});
  C(sl,'E'+tot,{formula:`SUM(E5:E${tot-1})`,result:r.revenue||0},{bold:true,fill:NAVY,color:WHITE,numFmt:BAHT,align:'right'});
  C(sl,'F'+tot,'',{fill:NAVY});

  // ---------- Journal ----------
  const jn=wb.addWorksheet('Journal',{views:[{showGridLines:false,state:'frozen',ySplit:4}]});
  jn.columns=[{width:8},{width:32},{width:14},{width:14},{width:26}];
  C(jn,'A1',store+' — Journal (today)',{bold:true,size:16,color:NAVY});
  ['Ref','Account','Debit ฿','Credit ฿','Notes'].forEach((h,i)=>hdr(jn,String.fromCharCode(65+i)+'4',h));
  let jr=5; const J=(ref,acct,dr,cr,note)=>{ C(jn,'A'+jr,ref||'',{size:9,color:GREY,align:'center',bd:true});
    C(jn,'B'+jr,acct,{bd:true}); C(jn,'C'+jr,dr==null?'':dr,{numFmt:BAHT,align:'right',bd:true});
    C(jn,'D'+jr,cr==null?'':cr,{numFmt:BAHT,align:'right',bd:true}); C(jn,'E'+jr,note||'',{size:8,color:GREY,bd:true}); jr++; };
  J('JE-01','Cash / PromptPay (counter)',rev,null,'Sales collected at counter');
  J('','  Sales revenue — drinks',null,p.drinkSales||0,'');
  J('','  Sales revenue — toppings',null,p.toppingSales||0,'');
  J('JE-02','Cost of goods sold',p.cogs||0,null,'Recognise COGS');
  J('','  Inventory — ingredients',null,p.ingredient||0,'');
  J('','  Packaging supplies',null,p.packaging||0,'');
  J('JE-03','Operating expenses (today)',p.opexDaily||0,null,"Today's share of fixed costs");
  J('','  Cash',null,p.opexDaily||0,'');
  const drTot=rev+(p.cogs||0)+(p.opexDaily||0);
  C(jn,'B'+jr,'TOTALS',{bold:true,fill:NAVY,color:WHITE});
  C(jn,'C'+jr,{formula:`SUM(C5:C${jr-1})`,result:drTot},{bold:true,fill:NAVY,color:WHITE,numFmt:BAHT,align:'right'});
  C(jn,'D'+jr,{formula:`SUM(D5:D${jr-1})`,result:drTot},{bold:true,fill:NAVY,color:WHITE,numFmt:BAHT,align:'right'});
  C(jn,'E'+jr,'',{fill:NAVY}); jr++;
  C(jn,'B'+jr,'Check (Dr − Cr)',{bold:true,color:GREY});
  C(jn,'C'+jr,{formula:`C${jr-1}-D${jr-1}`,result:0},{numFmt:BAHT,align:'right',bold:true});
  C(jn,'D'+jr,'BALANCED',{bold:true,color:'FF008000'});

  return await wb.xlsx.writeBuffer();
}
