// Builds the YO-DEE Yogurt Sales & Financial Report workbook with live formulas.
// Run: node reports/build-report.js
import ExcelJS from 'exceljs';

const NAVY='FF1E3A5F', ACCENT='FF1AB3CE', LIGHT='FFEAF6F9', BAND='FFF5F8FA';
const BLUE='FF0000FF', GREEN='FF008000', BLACK='FF000000', WHITE='FFFFFFFF', GREY='FF5C7187';
const BAHT='"฿"#,##0;("฿"#,##0);"-"', BAHT2='"฿"#,##0.00', PCT='0.0%', NUM='#,##0;(#,##0);"-"';
const F='Arial';

const wb=new ExcelJS.Workbook();
wb.creator='YO-DEE Yogurt'; wb.created=new Date('2026-06-07T00:00:00Z');

// ---- helpers ----
const thin={style:'thin',color:{argb:'FFD0D8DF'}};
const border=(c)=>{c.border={top:thin,left:thin,bottom:thin,right:thin};};
function cell(ws,addr,value,{font={},numFmt,fill,align,wrap,bd}={}){
  const c=ws.getCell(addr);
  c.value=value;
  c.font={name:F,size:10,color:{argb:BLACK},...font};
  if(numFmt) c.numFmt=numFmt;
  if(fill) c.fill={type:'pattern',pattern:'solid',fgColor:{argb:fill}};
  c.alignment={vertical:'middle',...(align?{horizontal:align}:{}),...(wrap?{wrapText:true}:{})};
  if(bd) border(c);
  return c;
}
const hdr=(ws,addr,txt)=>cell(ws,addr,txt,{font:{bold:true,color:{argb:WHITE},size:10},fill:NAVY,align:'center',bd:true});
const titleRow=(ws,txt,sub)=>{ cell(ws,'A1',txt,{font:{bold:true,size:16,color:{argb:NAVY}}}); if(sub) cell(ws,'A2',sub,{font:{size:11,color:{argb:GREY}}}); };

// ============ data (matches POS seed.js, prices from the menu board) ============
const items=[
 [1,'โยเกิร์ตปั่น Original','Yogurt Original',40,18],
 [2,'โยเกิร์ตปั่นข้าวเหนียวมูล','Yogurt w/ Midnight Sticky Rice',49,10],
 [3,'โยเกิร์ตปั่นข้าวโอ๊ต','Yogurt with Oats',49,8],
 [4,'โยเกิร์ตปั่นมะม่วง','Yogurt with Mango',49,16],
 [5,'โยเกิร์ตปั่นสตรอวเบอร์รี่','Yogurt with Strawberry',49,14],
 [6,'โยเกิร์ตปั่นบัวลอย','Yogurt with Rice Balls',49,9],
 [7,'โยเกิร์ตปั่นบุกน้ำผึ้ง','Yogurt with Honey Konjac',49,7],
 [8,'โยเกิร์ตปั่นโอริโอ้','Yogurt with Oreo',49,12],
 [9,'โยเกิร์ตปั่นคิทแคท','Yogurt with KitKat',49,11],
 [10,'โยเกิร์ตปั่นอโวคาโด','Yogurt with Avocado',59,6],
 [11,'โยเกิร์ตปั่นน้ำผึ้ง','Yogurt with Honey',49,7],
 [12,'โยเกิร์ตปั่นเฉาก๊วย','Yogurt with Grass Jelly',49,8],
 [13,'โยเกิร์ตปั่นปีโป้','Yogurt with Pipo Jelly',49,9],
 [14,'โยเกิร์ตปั่นกล้วย','Yogurt with Banana',49,10],
 [15,'โยเกิร์ตปั่นอโวคาโดสาหร่ายสไปรูลิน่า','Yogurt w/ Avocado Blue Spirulina',65,4],
 [16,'โยเกิร์ตปั่นข้าวเหนียวมะม่วง','Yogurt w/ Mango & Sticky Rice',59,6],
];
// assumptions
const A={days:30,ppay:0.55,ingPct:0.32,packPerCup:4.5,topPerDay:60,topPrice:10,
  rent:8000,wages:18000,util:3500,supplies:2500,mktg:800};
// budgets (targets) for variance
const BUD={rev:235000,cogs:95000,opex:34000};

// ---- precompute cached results so the file opens clean in Excel ----
const cash=1-A.ppay;
const units=items.map(it=>it[4]*A.days);
const gross=items.map((it,i)=>units[i]*it[3]);
const drinkSales=gross.reduce((s,v)=>s+v,0);
const cups=units.reduce((s,v)=>s+v,0);
const topUnits=A.topPerDay*A.days, topSales=topUnits*A.topPrice;
const revenue=drinkSales+topSales;
const ing=A.ingPct*revenue, pack=A.packPerCup*cups, cogs=ing+pack;
const gp=revenue-cogs, opex=A.rent+A.wages+A.util+A.supplies+A.mktg, net=gp-opex;

// ===================================================================
// SHEET 1 — COVER
// ===================================================================
const cv=wb.addWorksheet('Cover',{views:[{showGridLines:false}]});
cv.columns=[{width:3},{width:30},{width:26},{width:30}];
cell(cv,'B2','YO-DEE YOGURT',{font:{bold:true,size:22,color:{argb:NAVY}}});
cell(cv,'B3','Sales & Financial Report',{font:{size:13,color:{argb:ACCENT},bold:true}});
cell(cv,'B5','Branch',{font:{bold:true,color:{argb:GREY}}}); cell(cv,'C5','SAT Market — ตลาดนัด กกท');
cell(cv,'B6','Period',{font:{bold:true,color:{argb:GREY}}}); cell(cv,'C6','June 2026',{font:{color:{argb:BLUE}}});
cell(cv,'B7','Prepared',{font:{bold:true,color:{argb:GREY}}}); cell(cv,'C7','2026-06-07');
cell(cv,'B8','Currency',{font:{bold:true,color:{argb:GREY}}}); cell(cv,'C8','Thai Baht (฿)');

cell(cv,'B10','SUMMARY — THIS PERIOD',{font:{bold:true,size:11,color:{argb:WHITE}},fill:NAVY,align:'left'});
cell(cv,'C10','',{fill:NAVY});
const kpi=(r,label,formula,res,fmt)=>{ cell(cv,'B'+r,label,{font:{bold:true,color:{argb:GREY}},bd:true});
  cell(cv,'C'+r,{formula,result:res},{font:{color:{argb:GREEN},bold:true},numFmt:fmt,align:'right',bd:true}); };
kpi(11,'Total Revenue','IncomeStatement!B8',revenue,BAHT);
kpi(12,'Gross Profit','IncomeStatement!B13',gp,BAHT);
kpi(13,'Operating Expenses','IncomeStatement!B20',opex,BAHT);
kpi(14,'Net Profit','IncomeStatement!B21',net,BAHT);
kpi(15,'Net Margin','IncomeStatement!C21',net/revenue,PCT);
kpi(16,'Cups Sold','Sales!G26',cups,NUM);

cell(cv,'B18','CONTENTS',{font:{bold:true,size:11,color:{argb:NAVY}}});
const toc=[['Assumptions','Editable inputs — change these to model your month'],
 ['Sales','Redesigned sales report by menu item (qty, price, revenue, mix)'],
 ['IncomeStatement','Profit & Loss — revenue, COGS, gross profit, opex, net'],
 ['Journal','Double-entry journal entries (sales, COGS, expenses)'],
 ['Variance','Actual vs Budget with favourable/unfavourable flags']];
toc.forEach((t,i)=>{ const r=19+i; cell(cv,'B'+r,t[0],{font:{bold:true,color:{argb:ACCENT}}}); cell(cv,'C'+r,t[1],{font:{color:{argb:GREY},size:9}}); cv.mergeCells('C'+r+':D'+r); });
cell(cv,'B26','Blue = input · Black = formula · Green = links from another sheet',{font:{italic:true,size:8,color:{argb:GREY}}});
cv.mergeCells('B26:D26');

// ===================================================================
// SHEET 2 — ASSUMPTIONS
// ===================================================================
const as=wb.addWorksheet('Assumptions',{views:[{showGridLines:false}]});
as.columns=[{width:34},{width:16},{width:40}];
titleRow(as,'Assumptions & Inputs','Blue cells are editable — every other sheet recalculates from these.');
const arow=(r,label,val,fmt,note,input=true)=>{
  cell(as,'A'+r,label,{bd:true});
  cell(as,'B'+r,val,{font:{color:{argb:input?BLUE:BLACK}},numFmt:fmt,align:'right',bd:true});
  if(note) cell(as,'C'+r,note,{font:{size:8,color:{argb:GREY}},bd:true});
};
const asHdr=(r,t)=>{cell(as,'A'+r,t,{font:{bold:true,color:{argb:WHITE}},fill:ACCENT,bd:true});cell(as,'B'+r,'',{fill:ACCENT,bd:true});cell(as,'C'+r,'',{fill:ACCENT,bd:true});};
asHdr(4,'Operating');
arow(5,'Days open in period',A.days,'0','number of selling days');
arow(6,'PromptPay share of sales',A.ppay,PCT,'rest collected as cash');
cell(as,'A7','Cash share of sales',{bd:true}); cell(as,'B7',{formula:'1-B6',result:cash},{numFmt:PCT,align:'right',bd:true}); cell(as,'C7','= 1 − PromptPay share',{font:{size:8,color:{argb:GREY}},bd:true});
asHdr(8,'Cost of goods');
arow(9,'Ingredient cost (% of revenue)',A.ingPct,PCT,'yogurt, fruit, toppings');
arow(10,'Packaging cost per cup (฿)',A.packPerCup,BAHT2,'cup + lid + spoon + bag');
asHdr(11,'Topping add-ons');
arow(12,'Avg topping add-ons per day',A.topPerDay,'0','extra toppings customers add');
arow(13,'Topping price (฿)',A.topPrice,BAHT,'per add-on');
asHdr(14,'Operating expenses (per period, ฿)');
arow(15,'Rent / stall fee',A.rent,BAHT);
arow(16,'Staff wages',A.wages,BAHT);
arow(17,'Utilities (electric / water / gas)',A.util,BAHT);
arow(18,'Supplies & misc',A.supplies,BAHT);
arow(19,'Marketing / LINE',A.mktg,BAHT);
cell(as,'A20','Total operating expenses',{font:{bold:true},bd:true});
cell(as,'B20',{formula:'SUM(B15:B19)',result:opex},{font:{bold:true},numFmt:BAHT,align:'right',bd:true});
cell(as,'C20','',{bd:true});

// ===================================================================
// SHEET 3 — SALES
// ===================================================================
const sl=wb.addWorksheet('Sales',{views:[{showGridLines:false}]});
sl.columns=[{width:5},{width:30},{width:30},{width:12},{width:12},{width:8},{width:12},{width:15},{width:11}];
titleRow(sl,'Sales Report — by menu item');
cell(sl,'A2',{formula:'"Period: "&Cover!C6',result:'Period: June 2026'},{font:{size:11,color:{argb:GREEN}}});
const H=['No','Menu (ไทย)','Menu (English)','Unit ฿','Avg/Day','Days','Units','Gross ฿','% Sales'];
H.forEach((h,i)=>hdr(sl,String.fromCharCode(65+i)+'4',h));
items.forEach((it,i)=>{ const r=5+i;
  cell(sl,'A'+r,it[0],{align:'center',bd:true});
  cell(sl,'B'+r,it[1],{bd:true});
  cell(sl,'C'+r,it[2],{font:{color:{argb:GREY}},bd:true});
  cell(sl,'D'+r,it[3],{font:{color:{argb:BLUE}},numFmt:BAHT,align:'right',bd:true});           // input price
  cell(sl,'E'+r,it[4],{font:{color:{argb:BLUE}},numFmt:'0',align:'right',bd:true});            // input avg/day
  cell(sl,'F'+r,{formula:'Assumptions!$B$5',result:A.days},{font:{color:{argb:GREEN}},align:'right',bd:true});
  cell(sl,'G'+r,{formula:`E${r}*F${r}`,result:units[i]},{numFmt:NUM,align:'right',bd:true});
  cell(sl,'H'+r,{formula:`G${r}*D${r}`,result:gross[i]},{numFmt:BAHT,align:'right',bd:true});
  cell(sl,'I'+r,{formula:`H${r}/$H$25`,result:gross[i]/revenue},{numFmt:PCT,align:'right',bd:true});
});
// topping add-on row (21)
cell(sl,'A21','+',{align:'center',bd:true});
cell(sl,'B21','ท็อปปิ้งเพิ่ม (add-ons)',{bd:true});
cell(sl,'C21','Topping add-ons',{font:{color:{argb:GREY}},bd:true});
cell(sl,'D21',{formula:'Assumptions!$B$13',result:A.topPrice},{font:{color:{argb:GREEN}},numFmt:BAHT,align:'right',bd:true});
cell(sl,'E21',{formula:'Assumptions!$B$12',result:A.topPerDay},{font:{color:{argb:GREEN}},align:'right',bd:true});
cell(sl,'F21',{formula:'Assumptions!$B$5',result:A.days},{font:{color:{argb:GREEN}},align:'right',bd:true});
cell(sl,'G21',{formula:'E21*F21',result:topUnits},{numFmt:NUM,align:'right',bd:true});
cell(sl,'H21',{formula:'G21*D21',result:topSales},{numFmt:BAHT,align:'right',bd:true});
cell(sl,'I21',{formula:'H21/$H$25',result:topSales/revenue},{numFmt:PCT,align:'right',bd:true});
// totals block
const tl=(r,label,formula,res,fmt,bold=false)=>{ cell(sl,'C'+r,label,{font:{bold:bold,color:{argb:bold?NAVY:GREY}}});
  cell(sl,'H'+r,{formula,result:res},{font:{bold:bold},numFmt:fmt,align:'right'}); };
tl(23,'Total drink sales','SUM(H5:H20)',drinkSales,BAHT,true);
tl(24,'Topping add-on sales','H21',topSales,BAHT);
cell(sl,'C25','TOTAL REVENUE',{font:{bold:true,color:{argb:WHITE}},fill:NAVY});
cell(sl,'H25',{formula:'H23+H24',result:revenue},{font:{bold:true,color:{argb:WHITE}},fill:NAVY,numFmt:BAHT,align:'right'});
cell(sl,'C26','Total cups sold',{font:{color:{argb:GREY}}});
cell(sl,'G26',{formula:'SUM(G5:G20)',result:cups},{numFmt:NUM,align:'right',font:{bold:true}});
cell(sl,'C27','Average ฿ / cup',{font:{color:{argb:GREY}}});
cell(sl,'H27',{formula:'H23/G26',result:drinkSales/cups},{numFmt:BAHT2,align:'right'});

// ===================================================================
// SHEET 4 — INCOME STATEMENT
// ===================================================================
const is=wb.addWorksheet('IncomeStatement',{views:[{showGridLines:false}]});
is.columns=[{width:34},{width:16},{width:12}];
titleRow(is,'Income Statement (P&L)');
cell(is,'A2',{formula:'"Period: "&Cover!C6',result:'Period: June 2026'},{font:{size:11,color:{argb:GREEN}}});
hdr(is,'A4','Line'); hdr(is,'B4','Amount ฿'); hdr(is,'C4','% Rev');
const isLine=(r,label,formula,res,{fmt=BAHT,pf,pr,bold,fill,col}={})=>{
  cell(is,'A'+r,label,{font:{bold:bold,color:{argb:fill?WHITE:(bold?NAVY:BLACK)}},fill,bd:true});
  cell(is,'B'+r,{formula,result:res},{font:{bold:bold,color:{argb:fill?WHITE:(col||BLACK)}},numFmt:fmt,align:'right',fill,bd:true});
  if(pf!==undefined) cell(is,'C'+r,{formula:pf,result:pr},{font:{bold:bold,color:{argb:fill?WHITE:GREY},size:9},numFmt:PCT,align:'right',fill,bd:true});
  else cell(is,'C'+r,'',{fill,bd:true});
};
cell(is,'A5','Revenue',{font:{bold:true,color:{argb:ACCENT}},bd:true});cell(is,'B5','',{bd:true});cell(is,'C5','',{bd:true});
isLine(6,'  Drink sales','Sales!H23',drinkSales,{pf:'B6/$B$8',pr:drinkSales/revenue,col:GREEN});
isLine(7,'  Topping add-ons','Sales!H24',topSales,{pf:'B7/$B$8',pr:topSales/revenue,col:GREEN});
isLine(8,'Total Revenue','B6+B7',revenue,{pf:'B8/$B$8',pr:1,bold:true});
cell(is,'A9','Cost of Goods Sold',{font:{bold:true,color:{argb:ACCENT}},bd:true});cell(is,'B9','',{bd:true});cell(is,'C9','',{bd:true});
isLine(10,'  Ingredients','Assumptions!B9*B8',ing,{pf:'B10/$B$8',pr:ing/revenue,col:GREEN});
isLine(11,'  Packaging','Assumptions!B10*Sales!G26',pack,{pf:'B11/$B$8',pr:pack/revenue,col:GREEN});
isLine(12,'Total COGS','B10+B11',cogs,{pf:'B12/$B$8',pr:cogs/revenue,bold:true});
isLine(13,'Gross Profit','B8-B12',gp,{pf:'B13/$B$8',pr:gp/revenue,bold:true,fill:ACCENT});
cell(is,'A14','Operating Expenses',{font:{bold:true,color:{argb:ACCENT}},bd:true});cell(is,'B14','',{bd:true});cell(is,'C14','',{bd:true});
isLine(15,'  Rent / stall fee','Assumptions!B15',A.rent,{pf:'B15/$B$8',pr:A.rent/revenue,col:GREEN});
isLine(16,'  Staff wages','Assumptions!B16',A.wages,{pf:'B16/$B$8',pr:A.wages/revenue,col:GREEN});
isLine(17,'  Utilities','Assumptions!B17',A.util,{pf:'B17/$B$8',pr:A.util/revenue,col:GREEN});
isLine(18,'  Supplies & misc','Assumptions!B18',A.supplies,{pf:'B18/$B$8',pr:A.supplies/revenue,col:GREEN});
isLine(19,'  Marketing / LINE','Assumptions!B19',A.mktg,{pf:'B19/$B$8',pr:A.mktg/revenue,col:GREEN});
isLine(20,'Total Operating Expenses','SUM(B15:B19)',opex,{pf:'B20/$B$8',pr:opex/revenue,bold:true});
isLine(21,'NET PROFIT','B13-B20',net,{pf:'B21/$B$8',pr:net/revenue,bold:true,fill:NAVY});
cell(is,'A23','Note: cash-basis, single stall. No depreciation/tax modelled (turnover below the ฿1.8M VAT threshold).',{font:{italic:true,size:8,color:{argb:GREY}}});
is.mergeCells('A23:C23');

// ===================================================================
// SHEET 5 — JOURNAL ENTRIES
// ===================================================================
const jn=wb.addWorksheet('Journal',{views:[{showGridLines:false}]});
jn.columns=[{width:12},{width:8},{width:32},{width:14},{width:14},{width:30}];
titleRow(jn,'Journal Entries — period summary','Double-entry. Total debits must equal total credits.');
['Date','Ref','Account','Debit ฿','Credit ฿','Notes'].forEach((h,i)=>hdr(jn,String.fromCharCode(65+i)+'4',h));
const date='2026-06-30';
const J=(r,d,ref,acct,dr,drF,cr,crF,note)=>{
  cell(jn,'A'+r,d||'',{font:{size:9},bd:true}); cell(jn,'B'+r,ref||'',{font:{size:9,color:{argb:GREY}},align:'center',bd:true});
  cell(jn,'C'+r,acct,{bd:true});
  cell(jn,'D'+r, dr===null?'':{formula:drF,result:dr},{numFmt:BAHT,align:'right',font:{color:{argb:GREEN}},bd:true});
  cell(jn,'E'+r, cr===null?'':{formula:crF,result:cr},{numFmt:BAHT,align:'right',font:{color:{argb:GREEN}},bd:true});
  cell(jn,'F'+r,note||'',{font:{size:8,color:{argb:GREY}},bd:true});
};
J(4 ,date,'JE-01','Cash on hand',revenue*cash,'IncomeStatement!B8*Assumptions!B7',null,null,'Sales collected — cash');
J(5 ,'', '', 'PromptPay clearing',revenue*A.ppay,'IncomeStatement!B8*Assumptions!B6',null,null,'Sales collected — PromptPay');
J(6 ,'', '', '  Sales revenue — drinks',null,null,drinkSales,'IncomeStatement!B6','Recognise drink sales');
J(7 ,'', '', '  Sales revenue — toppings',null,null,topSales,'IncomeStatement!B7','Recognise topping sales');
J(8 ,date,'JE-02','Cost of goods sold',cogs,'IncomeStatement!B12',null,null,'Recognise COGS for period');
J(9 ,'', '', '  Inventory — ingredients',null,null,ing,'IncomeStatement!B10','Yogurt, fruit, toppings used');
J(10,'', '', '  Packaging supplies',null,null,pack,'IncomeStatement!B11','Cups, lids, spoons, bags');
J(11,date,'JE-03','Rent expense',A.rent,'Assumptions!B15',null,null,'Operating expenses paid');
J(12,'', '', 'Wages expense',A.wages,'Assumptions!B16',null,null,'');
J(13,'', '', 'Utilities expense',A.util,'Assumptions!B17',null,null,'');
J(14,'', '', 'Supplies & misc expense',A.supplies,'Assumptions!B18',null,null,'');
J(15,'', '', 'Marketing expense',A.mktg,'Assumptions!B19',null,null,'');
J(16,'', '', '  Cash on hand',null,null,opex,'SUM(D11:D15)','Opex settled in cash');
cell(jn,'C18','TOTALS',{font:{bold:true,color:{argb:WHITE}},fill:NAVY});
cell(jn,'D18',{formula:'SUM(D4:D16)',result:revenue+cogs+opex},{font:{bold:true,color:{argb:WHITE}},fill:NAVY,numFmt:BAHT,align:'right'});
cell(jn,'E18',{formula:'SUM(E4:E16)',result:revenue+cogs+opex},{font:{bold:true,color:{argb:WHITE}},fill:NAVY,numFmt:BAHT,align:'right'});
cell(jn,'C19','Check (Dr − Cr)',{font:{bold:true,color:{argb:GREY}}});
cell(jn,'D19',{formula:'D18-E18',result:0},{numFmt:BAHT,align:'right',font:{bold:true}});
cell(jn,'E19',{formula:'IF(D19=0,"BALANCED","OUT BY "&TEXT(D19,"#,##0")) ',result:'BALANCED'},{font:{bold:true,color:{argb:GREEN}}});

// ===================================================================
// SHEET 6 — VARIANCE
// ===================================================================
const vr=wb.addWorksheet('Variance',{views:[{showGridLines:false}]});
vr.columns=[{width:26},{width:15},{width:15},{width:15},{width:12},{width:14}];
titleRow(vr,'Variance Analysis — Actual vs Budget','Budget cells (blue) are editable targets.');
['Line','Actual ฿','Budget ฿','Variance ฿','Var %','Flag'].forEach((h,i)=>hdr(vr,String.fromCharCode(65+i)+'4',h));
const vline=(r,label,actF,actRes,budVal,budF,budRes,favWhenPositive,varRes)=>{
  cell(vr,'A'+r,label,{font:{bold:true},bd:true});
  cell(vr,'B'+r,{formula:actF,result:actRes},{font:{color:{argb:GREEN}},numFmt:BAHT,align:'right',bd:true});
  if(budF) cell(vr,'C'+r,{formula:budF,result:budRes},{numFmt:BAHT,align:'right',bd:true});
  else cell(vr,'C'+r,budVal,{font:{color:{argb:BLUE}},numFmt:BAHT,align:'right',bd:true});
  cell(vr,'D'+r,{formula:`B${r}-C${r}`,result:varRes},{numFmt:BAHT,align:'right',bd:true});
  cell(vr,'E'+r,{formula:`IFERROR(D${r}/C${r},0)`,result:varRes/(budRes??budVal)},{numFmt:PCT,align:'right',bd:true});
  const cond=favWhenPositive?`IF(D${r}>=0,"Favourable","Unfavourable")`:`IF(D${r}<=0,"Favourable","Unfavourable")`;
  const favRes=favWhenPositive?(varRes>=0?'Favourable':'Unfavourable'):(varRes<=0?'Favourable':'Unfavourable');
  cell(vr,'F'+r,{formula:cond,result:favRes},{font:{bold:true,color:{argb:favRes==='Favourable'?GREEN:'FFC0392B'}},align:'center',bd:true});
};
const budGP=BUD.rev-BUD.cogs, budNet=budGP-BUD.opex;
vline(5,'Total Revenue','IncomeStatement!B8',revenue,BUD.rev,null,null,true, revenue-BUD.rev);
vline(6,'Total COGS','IncomeStatement!B12',cogs,BUD.cogs,null,null,false, cogs-BUD.cogs);
vline(7,'Gross Profit','IncomeStatement!B13',gp,null,'C5-C6',budGP,true, gp-budGP);
vline(8,'Operating Expenses','IncomeStatement!B20',opex,BUD.opex,null,null,false, opex-BUD.opex);
vline(9,'Net Profit','IncomeStatement!B21',net,null,'C7-C8',budNet,true, net-budNet);
cell(vr,'A11','Favourable = better than target (more revenue/profit, or lower cost).',{font:{italic:true,size:8,color:{argb:GREY}}});
vr.mergeCells('A11:F11');

// freeze header rows
[sl,is,jn,vr].forEach(ws=>{ ws.views=[{showGridLines:false,state:'frozen',ySplit:4}]; });

const out='reports/YO-DEE_Sales_Financial_Report.xlsx';
await wb.xlsx.writeFile(out);
console.log('WROTE '+out);
console.log(JSON.stringify({revenue,cogs,gp,opex,net,cups,drinkSales,topSales,netMargin:+(net/revenue*100).toFixed(1)}));
