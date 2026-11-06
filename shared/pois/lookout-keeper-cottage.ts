// One keeper's home: authored domestic rooms, not a random kitchen recipe.
// Item silhouettes and simulation boxes share InteriorItem / itemColliders.
import {FINISH,itemColliders,type InteriorItem,type InteriorLayout,type InteriorRoom,type ItemKind} from './interior-kit';
import {bx,kitRoom,toWorld,wall,type Frame,type Piece} from './coast-kit';
import * as dmath from "../sim/dmath";
export const KEEPER_ZONES=[
 {id:'keeper-cottage-living-kitchen',x:-2.125,z:0,w:7.05,d:7.3,role:'living' as const},
 {id:'keeper-cottage-bedroom',x:3.625,z:-2.125,w:4.05,d:3.05,role:'bedroom' as const},
 {id:'keeper-cottage-chart-room',x:3.625,z:1.625,w:4.05,d:4.05,role:'studio' as const},
];
export function keeperPartitions(floor:number,h:number):Piece[]{
 return [
 ...wall('cot:partition',1.5,-3.65,1.5,3.65,floor,h,.2,[{u:1.65,w:1.5,y0:0,h:2.7},{u:5.45,w:1.5,y0:0,h:2.7}],{surf:'wood'}),
 bx('cot:partition',1.6,floor,-.6,5.65,floor+h,-.4,{surf:'wood'}),
 ...[-5.05,-2,1.25].map(x=>bx('cot:porch-post',x-.08,floor,6.2,x+.08,floor+2.75,6.36,{surf:'wood'})),
 {k:'cot:awning',c:[-1.9,floor+3.1,5.3],h:[3.55,.03,1.5],pitch:dmath.atan2(.55,2.7),surf:'metal'},
 // Outside the stair and both entry corridors. The porch bench has real supports/seat/back.
 bx('cot:bench',-4.65,floor,4.23,-4.5,floor+.43,4.8,{surf:'wood'}),
 bx('cot:bench',-2.8,floor,4.23,-2.65,floor+.43,4.8,{surf:'wood'}),
 bx('cot:bench',-4.75,floor+.43,4.15,-2.55,floor+.53,4.9,{surf:'wood'}),
 bx('cot:bench',-4.75,floor+.53,4.15,-2.55,floor+1.03,4.25,{surf:'wood'}),
 ];
}
export function keeperRooms(frame:Frame,floor:number,h:number):InteriorRoom[]{
 const W=(side:0|1|2|3,at:number,w:number,y0=1,h=1.5)=>({side,at,w,kind:'window' as const,y0,h});
 const D=(side:0|1|2|3,at:number,w=1.5)=>({side,at,w,kind:'door' as const,h:2.7});
 return KEEPER_ZONES.map((q,i)=>kitRoom(frame,q.x,floor,q.z,{
 id:q.id,w:q.w,d:q.d,h,role:q.role,style:'house',seed:711+i,wallT:.2,
 finish:{floor:'boards',wall:'#e1dacb',wallMat:'plaster',dado:'#55766d',ceiling:'none',shell:false,glass:false,curtains:false},
 openings:i===0?[W(0,-1.875,1.3),D(0,.425,1.7),W(2,-1.375,1.3,1,1.4),D(2,2.625,1.7),D(1,-2),D(1,1.8),W(3,2.3,1.1,1.2,1.2)]:i===1?[D(3,.125),W(2,.375,1.3,1,1.4)]:[D(3,.175),W(0,-1.225,1.4),W(0,.675,1.4),W(1,-.525,1.4)],
 // Actual full-floor hatch in room coordinates; finish does not hide its opening.
 ...(i===0?{keepOut:[[-3.525,-3.65,-2.025,1.55]],ceilHoles:[[-3.525,-3.65,-2.025,1.05]]}:{}),
 }));
}
type Spec=[ItemKind,number,number,number,number,number,number?,number?,number?];
/** Room-local derived from a small explicitly placed cottage-local fixture list. */
const SPECS:Spec[][]=[
 [
 ['counter',-2.25,-3.18,1.5,.93,.7],['sink',-.95,-3.18,1.0,.94,.7],
 ['wood-stove',-.65,-1.0,.75,1.2,.65],
 ['counter',-2.1,-.35,1.7,.94,.85], // pantry island: solid cover, two circulation sides
 ['sofa',-3.75,2.65,2.0,.9,.9,Math.PI],
 ['coffee-table',-3.5,1.55,1.3,.48,.65],
 ['coat-rack',-2.85,3.53,.65,1.5,.13,Math.PI,1.1,0],
 ['lantern',-.95,1.5,.3,.4,.3,0,2.75,0],
 ['life-ring',-4.95,2.4,.5,.5,.08,Math.PI/2,1.65,0],
 ],
 [
 ['bed',4.5,-2.15,1.3,.92,2.15],['dresser',2.5,-3.2,1.1,.85,.65],
 ['nightstand',5.1,-.98,.7,.62,.55],['table-lamp',5.1,-.98,.25,.45,.25,0,.62,0],

 ],
 [
 ['map-table',3.9,1.7,1.4,.82,.9],['radio',3.7,1.45,.5,.28,.3,0,.82,0],
 ['bookshelf',4.95,-.19,.65,1.65,.36],
 ['chart',3.1,-.33,1.35,.8,.04,0,1.2,0],
 ['lantern',3.7,1.7,.3,.4,.3,0,2.65,0],

 ],
];
export function keeperLayouts(rooms:InteriorRoom[]):InteriorLayout[]{
 return rooms.map((room,i)=>{
 const q=KEEPER_ZONES[i];
 const items:InteriorItem[]=SPECS[i].map(([kind,x,z,w,h,d,yaw=0,y=0,col=1],j)=>({kind,x:x-q.x,z:z-q.z,w,h,d,yaw,y,col:col as 0|1,c:0,v:((i*31+j*17)%97)/97}));
 const lootLocal=i===0?{chests:[[-.3,2.9]],floor:[[-1.5,-2.1],[-2.05,2.1]]}:i===1?{chests:[[2.5,-.95]],floor:[[3.5,-1.0]]}:{chests:[[4.95,2.8]],floor:[[2.6,.4]]};
 return {room,role:q.role,finish:{...FINISH.house,...room.finish},items,colliders:items.filter(p=>p.col).flatMap(p=>itemColliders(room,p)),loot:{chests:lootLocal.chests.map(([x,z])=>{const p=toWorld({x:room.x,y:room.y,z:room.z,yaw:room.yaw},x-q.x,0,z-q.z);return [...p,room.yaw] as [number,number,number,number]}),floor:lootLocal.floor.map(([x,z])=>toWorld({x:room.x,y:room.y,z:room.z,yaw:room.yaw},x-q.x,0,z-q.z))},
 // A conservative room-local footprint flood.
 stats:footprintStats(room,items)};
 });
}

function footprintStats(room:InteriorRoom,items:InteriorItem[]):InteriorLayout['stats']{
 const cell=.2,R=.5,nx=Math.ceil(room.w/cell),nz=Math.ceil(room.d/cell),stepX=room.w/nx,stepZ=room.d/nz;
 const blocked=new Uint8Array(nx*nz),reach=new Uint8Array(nx*nz);
 const point=(i:number)=>[-room.w/2+(i%nx+.5)*stepX,-room.d/2+(Math.floor(i/nx)+.5)*stepZ];
 for(let i=0;i<blocked.length;i++){
 const [x,z]=point(i);
 if(Math.abs(x)>room.w/2-R||Math.abs(z)>room.d/2-R){blocked[i]=1;continue;}
 blocked[i]=Number(items.some(it=>{if(!it.col||it.y>.3)return false;const c=dmath.cos(it.yaw),s=dmath.sin(it.yaw),dx=x-it.x,dz=z-it.z;return Math.abs(dx*c-dz*s)<it.w/2+R&&Math.abs(dx*s+dz*c)<it.d/2+R;})||(room.keepOut??[]).some(k=>{const a=Array.isArray(k)?k:k.r;return x>a[0]-R&&x<a[2]+R&&z>a[1]-R&&z<a[3]+R;}));
 }
 const doors=room.openings.filter(o=>o.kind==='door'||o.kind==='gap').map(o=>o.side===0?[o.at,room.d/2-R-.15]:o.side===2?[o.at,-room.d/2+R+.15]:o.side===1?[room.w/2-R-.15,o.at]:[-room.w/2+R+.15,o.at]);
 const nearest=([x,z]:number[])=>{let got=-1,best=Infinity;for(let i=0;i<blocked.length;i++)if(!blocked[i]){const [px,pz]=point(i),d=dmath.hypot(px-x,pz-z);if(d<best){best=d;got=i;}}return got;};
 const anchors=doors.map(nearest),q:number[]=[];
 if(anchors[0]>=0){reach[anchors[0]]=1;q.push(anchors[0]);}
 for(let head=0;head<q.length;head++){const i=q[head];for(const [dx,dz]of [[1,0],[-1,0],[0,1],[0,-1]]){const ix=i%nx+dx,iz=Math.floor(i/nx)+dz,j=iz*nx+ix;if(ix<0||ix>=nx||iz<0||iz>=nz||blocked[j]||reach[j])continue;reach[j]=1;q.push(j);}}
 return {free:Array.from(blocked).filter(v=>!v).length*stepX*stepZ,reachable:q.length*stepX*stepZ,connected:anchors.every(i=>i>=0&&!!reach[i]),tries:0};
}
/** Hollow dormer: the roof has two thin slope sheets; no solid triangular rear cap can hang into the attic. */
export function keeperDormerPieces(eave:number,hd:number,pitch:number,dx:number,dw:number):Piece[]{
 const zf=hd-1,yb=eave+(hd-zf)*dmath.tan(pitch)-.2,dh=2.1,back=1.9;
 const out:Piece[]=[];
 for(const sign of [-1,1])out.push(bx('cot:dormer-shell',dx+sign*(dw/2-.06)-.06,yb,zf-back,dx+sign*(dw/2-.06)+.06,yb+dh,zf,{surf:'wood'}));
 out.push(bx('cot:dormer-shell',dx-dw/2,yb+dh-.12,zf-back,dx+dw/2,yb+dh,zf,{surf:'wood'}));
 out.push(bx('cot:dormer-shell',dx-dw/2,yb,zf-.12,dx+dw/2,yb+.45,zf,{surf:'wood'}));
 out.push(bx('cot:dormer-shell',dx-dw/2,yb+1.55,zf-.12,dx+dw/2,yb+dh,zf,{surf:'wood'}));
 for(const sign of [-1,1])out.push(bx('cot:dormer-shell',dx+sign*(.5+(dw-1)/4)-(dw-1)/4,yb+.45,zf-.12,dx+sign*(.5+(dw-1)/4)+(dw-1)/4,yb+1.55,zf,{surf:'wood'}));
 out.push(bx('cot:dormer-glass',dx-.5,yb+.45,zf-.09,dx+.5,yb+1.55,zf-.03,{surf:'glass',noShoot:true}));
 // Close the rear ceiling/main-roof junction and bind both cheek tops into the rafters.
 const rear=zf-back;
 // The rear bearing follows the actual main-roof underside. Its former flat
 // top (+150 mm above that plane) broke through the outside valley corners.
 // A slope-cut timber cap contacts the roof; eight body blocks overlap its
 // underside by at most22 mm, forming a closed bearing above the flat ceiling.
 const cpMain=dmath.cos(pitch),spMain=dmath.sin(pitch),capHalf=.025;
 // keeperMainRoof's actual substrate centre includes its signed normal
 // offset. Use that emitted plane, rather than the nominal roof height.
 const mainRun=hd+.6,mainY=eave+(hd-mainRun/2)*dmath.tan(pitch)+.1*cpMain;
 const mainZ=mainRun/2-.1*spMain;
 const roofUnder=(z:number)=>mainY+(mainZ-z)*dmath.tan(pitch)-.1/cpMain;
 out.push({k:'cot:dormer-header',c:[dx,roofUnder(rear)-capHalf*cpMain,rear-capHalf*spMain],
   h:[dw/2,capHalf,.12/cpMain],pitch,surf:'wood'});
 for(let i=0;i<8;i++){
   const z0=rear-.08+i*.02,z1=z0+.02;
   out.push(bx('cot:dormer-header',dx-dw/2,yb+dh-.12,z0,dx+dw/2,
     roofUnder(z0)-2*capHalf/cpMain,z1,{surf:'wood'}));
 }
 // The bearing's flat top touches the lowest roof underside over its width.
 // Raising it a fixed .25 m pierced the exterior tile face at the cheek eave.
 const cheekRun=(dw+.3)/2,cheekCos=dmath.cos(dmath.atan2(1.05,cheekRun));
 const cheekTop=yb+dh+1.05*(1-(dw/2)/cheekRun)-.06/cheekCos;
 for(const sign of [-1,1])out.push(bx('cot:dormer-header',dx+sign*(dw/2-.06)-.06,yb+dh-.06,rear,dx+sign*(dw/2-.06)+.06,cheekTop,zf,{surf:'wood'}));
 // A real valley is V-shaped in plan. Rectangular sheets cross BELOW the main roof
 // at their rear outer corners. Every shared/drawn strip stops outside that plane.
 const run=(dw+.3)/2,rise=1.05,angle=dmath.atan2(rise,run),cp=dmath.cos(angle),roofZ1=zf+.345,n=8;
 for(const sign of [-1,1])for(let i=0;i<n;i++){
   const d0=run*i/n,d1=run*(i+1)/n,dm=(d0+d1)/2;
   const underside=yb+dh+rise*(1-d1/run)-.06/cp;
   const roofZ0=hd-(underside-eave-.2*dmath.cos(pitch))/dmath.tan(pitch)+.01;
   out.push({k:'cot:dormer-roof',c:[dx+sign*dm,yb+dh+rise*(1-dm/run),(roofZ0+roofZ1)/2],h:[(roofZ1-roofZ0)/2,.06,(d1-d0)/cp/2],yaw:Math.PI/2,pitch:sign*angle,surf:'wood'});
 }
 return out;
}
/** Clay profile dimensions shared by surface generation and valley metal fitting. */
export const KEEPER_ROOF_CLAY = { pitch: .3, course: .36, relief: .018, lap: .012, baseGap: .005 } as const;
/** Shared verge assembly. Board overlaps the roof by 30 mm; rounded edges remain
 * within the overlap, closing the former 40 mm daylight slit. */
export const KEEPER_ROOF_VERGE = { overhang: .5, boardWidth: .12, overlap: .03 } as const;
export function keeperRoofVerge(hl: number) {
 const edge = hl + KEEPER_ROOF_VERGE.overhang;
 const boardCenter = edge + KEEPER_ROOF_VERGE.boardWidth / 2 - KEEPER_ROOF_VERGE.overlap;
 return {edge, boardCenter, boardInner: boardCenter - KEEPER_ROOF_VERGE.boardWidth / 2};
}
/** Main roof patches share one slope plane and a real rectangular dormer opening. */
export function keeperMainRoof(eave:number,hd:number,hl:number,pitch:number,dx:number,dw:number):Piece[]{
 const run=hd+.6,len=run/dmath.cos(pitch)+.3,cy=eave+(hd-run/2)*dmath.tan(pitch);
 const out:Piece[]=[],edge=keeperRoofVerge(hl).edge;
 // Flat metal bears on pan crests; its underside meets the highest clay lap.
 const flashLift=.1+KEEPER_ROOF_CLAY.baseGap+2*KEEPER_ROOF_CLAY.relief+KEEPER_ROOF_CLAY.lap+.025;
 for(const sign of [-1,1]){
 const a=sign*pitch,sp=dmath.sin(a),cp=dmath.cos(a),baseY=cy+.1*cp,baseZ=sign*run/2-.1*sp;
 const patch=(x0:number,x1:number,t0:number,t1:number,k='cot:roof',th=.1,lift=0)=>{const mid=(t0+t1)/2;out.push({k,c:[(x0+x1)/2,baseY-sp*mid+cp*lift,baseZ+cp*mid+sp*lift],h:[(x1-x0)/2,th,(t1-t0)/2],pitch:a,surf:k==='cot:flash'?'metal':'wood'});};
 if(sign<0){patch(-edge,edge,-len/2,len/2);continue;}
 const x0=dx-dw/2+.06,x1=dx+dw/2-.06,t0=(1.1-baseZ)/cp,t1=(3.12-baseZ)/cp;
 patch(-edge,x0,-len/2,len/2);patch(x1,edge,-len/2,len/2);
 // Keep the main roof underneath the same stepped V valley where a rectangular
 // cut would expose the ceiling outside. Each column meets its dormer strip.
 const drun=(dw+.3)/2,drise=1.05,dcp=dmath.cos(dmath.atan2(drise,drun)),dtop=eave+dmath.tan(pitch)-.2+2.1+drise;
 for(const ds of [-1,1])for(let i=0;i<8;i++){
   const d0=drun*i/8,d1=drun*(i+1)/8;
   const ax=Math.max(x0,ds<0?dx-d1:dx+d0),bx=Math.min(x1,ds<0?dx-d0:dx+d1);
   if(bx<=ax)continue;
   const low=dtop-drise*d1/drun-.06/dcp;
   const z0=Math.max(1.1,hd-(low-eave-.2*dmath.cos(pitch))/dmath.tan(pitch)+.01),rt=(z0-baseZ)/cp;
   patch(ax,bx,-len/2,rt);patch(ax,bx,t1,len/2);
   patch(ax,bx,rt-.07,rt+.07,'cot:flash',.025,flashLift);
 }
 // Side aprons bear on exterior clay and meet the OUTER plaster cheek, never
 // straddling its 120 mm wall. Terminate at the real main-metal/cheek-top
 // intersection: a full roof-cut run leaves an exposed fin behind the dormer.
 const cheekTop=eave+dmath.tan(pitch)-.2+2.1;
 const sideThickness=.004,sideLift=flashLift-.025+sideThickness;
 // The uphill top corner includes the slab thickness; solve in slope space.
 const sideT0=(baseY+cp*(sideLift+sideThickness)-cheekTop)/sp;
 for(const side of [-1,1]){
   const cheekOuter=dx+side*dw/2;
   patch(side<0?cheekOuter-.12:cheekOuter,side<0?cheekOuter:cheekOuter+.12,
     Math.max(t0-.08,sideT0),t1+.08,'cot:flash',sideThickness,sideLift);
 }
 patch(x0,x1,t1-.08,t1+.08,'cot:flash',.025,flashLift);
 }
 return out;
}
