import { chromium } from "playwright";
const b = await chromium.launch();
const d = await b.newContext({ viewport:{width:1280,height:850} });
const p = await d.newPage();
await p.goto("http://localhost:4173/", { waitUntil:"networkidle" });
await p.waitForSelector(".tr",{timeout:15000}); await p.waitForTimeout(2000);
const cells = p.locator(".td-img");
const A = await cells.nth(5).boundingBox();
const enlargedIndex = ()=>p.evaluate(()=>{ const all=[...document.querySelectorAll(".td-img img")]; const i=all.findIndex(im=>im.getBoundingClientRect().width>100); return i; });
// Move the cursor along a vertical line THROUGH the center of cell A, stepping down
// past its bottom edge into where A's centered 200px preview overlaps the next rows.
const cx = A.x + A.width/2;
let seq=[];
for(let y = A.y - 4; y <= A.y + A.height + 30; y += 3){
  await p.mouse.move(cx, y);
  await p.waitForTimeout(40);
  seq.push(await enlargedIndex());
}
// count transitions (flicker = many alternations)
let trans=0; for(let i=1;i<seq.length;i++) if(seq[i]!==seq[i-1]) trans++;
console.log("enlarged-index sequence moving down center of img column:");
console.log(seq.join(" "));
console.log("transitions:", trans, "(smooth = ~1-2; flicker = many alternations like 5,-1,5,-1,...)");
await b.close();
