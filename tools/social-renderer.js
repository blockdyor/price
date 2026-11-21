// Offline masks: DejaVu Sans; original blockdyor logo reused from the approved proposal.
// No network, canvas, imports, or runtime dependencies. Native DEFLATE avoids costly JavaScript encoding loops.
async function socialPng(snapshot, height = 630) {
  height = height === 600 ? 600 : 630;
  const width = 1200, shift = (height - 630) / 2;
  const pixels = new Uint8Array((width + 1) * height);
  const finite = n => typeof n === 'number' && Number.isFinite(n);
  const currency = ['usd','eur','gbp','chf'].includes(snapshot.currency) ? snapshot.currency : 'usd';
  const days = ['1','7','30','90','365','1825'].includes(snapshot.days) ? snapshot.days : '7';
  const price = finite(snapshot.price) ? snapshot.price : null;
  const change = finite(snapshot.change) ? snapshot.change : null;
  const points = (Array.isArray(snapshot.prices) ? snapshot.prices : []).filter(p => Array.isArray(p) && finite(p[0]) && finite(p[1])).sort((a,b)=>a[0]-b[0]);
  const trend = change === null && points.length > 1 ? Math.sign(points.at(-1)[1] - points[0][1]) : Math.sign(change || 0);
  const bg = [29,31,33], white = [246,247,250], muted = [182,187,196];
  const accent = trend > 0 ? [16,185,129] : trend < 0 ? [239,68,68] : muted;
  const palette = new Uint8Array(48);
  const color = (index,target,alpha) => {for(let c=0;c<3;c++)palette[index*3+c]=Math.round(bg[c]+(target[c]-bg[c])*alpha);};
  color(0,bg,1);
  for(let i=1;i<=7;i++)color(i,white,i/7);
  for(let i=0;i<4;i++){color(8+i,accent,[.12,.4,.7,1][i]);color(12+i,muted,(i+1)/4);}
  function mask(asset, x, y, scale=1, ink='white') {
    if(!asset || !asset.w)return;
    if(!asset.pixels){
      const data = atob(asset.d), decoded = new Uint8Array(asset.w*asset.h);let offset=0;
      for(let i=0;i<data.length;i++){const byte=data.charCodeAt(i),n=(byte&31)+1;decoded.fill(byte>>>5,offset,offset+n);offset+=n;}
      asset.pixels=decoded;
    }
    const left=Math.round(x+asset.x*scale),top=Math.round(y+asset.y*scale);
    const w=Math.max(1,Math.round(asset.w*scale)),h=Math.max(1,Math.round(asset.h*scale));
    for(let dy=0;dy<h;dy++){
      const yy=top+dy;if(yy<0||yy>=height)continue;
      const sy=(dy/scale)|0;
      for(let dx=0;dx<w;dx++){
        const xx=left+dx;if(xx<0||xx>=width)continue;
        const alpha=asset.pixels[sy*asset.w+((dx/scale)|0)];
        if(alpha)pixels[yy*(width+1)+xx+1]=ink==='white'?alpha:(ink==='accent'?8:12)+Math.min(3,Math.round(alpha*3/7));
      }
    }
  }
  const textWidth=(text,prefix)=>[...text].reduce((sum,ch)=>sum+(SOCIAL_MASKS[prefix+ch]?.a||0),0);
  function text(value,prefix,y,ink='white',maxWidth=600,x=null){
    const w=textWidth(value,prefix),scale=Math.min(1,maxWidth/Math.max(1,w));
    let cursor=x===null?(width-w*scale)/2:x;
    for(const ch of value){const a=SOCIAL_MASKS[prefix+ch];mask(a,cursor,y,scale,ink);cursor+=(a?.a||0)*scale;}
    return w*scale;
  }
  const stamp=finite(snapshot.time)&&Math.abs(snapshot.time)<=8640000000000000?new Date(snapshot.time):null;
  const date=stamp&&stamp.getUTCFullYear()>=0&&stamp.getUTCFullYear()<=9999?stamp.toISOString().slice(0,16).replace('T',' ')+' UTC':'n/a';
  const currencySign={usd:'$',eur:'€',gbp:'£',chf:'CHF '}[currency];
  let number='n/a';
  if(price!==null){
    const magnitude=Math.abs(price);
    number=currencySign+(magnitude>=1e12||(magnitude>0&&magnitude<1e-8)?price.toExponential(2):price.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:magnitude>0&&magnitude<.01?8:2}));
  }
  // The largest price is fitted rather than clipped by the central square crop.
  mask(SOCIAL_MASKS.logo,(width-184)/2+2,49+shift);
  const heading=SOCIAL_MASKS['c'+currency.toUpperCase()];
  mask(heading,(width-heading.a)/2,152+shift,1,'muted');
  text(number,'p',204+shift,'white');
  const delta=change===null?'n/a':(change>0?'+':change<0?'−':'')+(Math.abs(change)>=1e6?Math.abs(change).toExponential(2):Math.abs(change).toFixed(2))+'%';
  const range=SOCIAL_MASKS['r'+days],dw=textWidth(delta,'d'),total=dw+range.a;
  const deltaScale=Math.min(1,600/total),start=(width-total*deltaScale)/2;
  text(delta,'d',316+shift,change===null?'muted':'accent',dw*deltaScale,start);
  mask(range,start+dw*deltaScale,319+shift,deltaScale,'muted');
  if(points.length>1 && points.at(-1)[0]>points[0][0]) {
    let lo=Infinity,hi=-Infinity;for(const p of points){lo=Math.min(lo,p[1]);hi=Math.max(hi,p[1]);}
    // Normalize before subtraction to keep even extreme finite quotes drawable.
    const magnitude=Math.max(Math.abs(lo),Math.abs(hi),1),low=lo/magnitude,high=hi/magnitude,span=high-low;
    const t0=points[0][0],t1=points.at(-1)[0];
    const point=p=>[370+460*((p[0]/2-t0/2)/(t1/2-t0/2)),378+shift+(span?10+78*(high-p[1]/magnitude)/span:49)];
    let previous=point(points[0]);
    for(let i=1;i<points.length;i++){
      const current=point(points[i]),[ax,ay]=previous,[bx,by]=current;
      const vx=bx-ax,vy=by-ay,len=vx*vx+vy*vy;
      const minX=Math.max(369,Math.floor(Math.min(ax,bx)-3)),maxX=Math.min(832,Math.ceil(Math.max(ax,bx)+3));
      const minY=Math.max(0,Math.floor(Math.min(ay,by)-3)),maxY=Math.min(height-1,Math.ceil(Math.max(ay,by)+3));
      for(let y=minY;y<=maxY;y++)for(let x=minX;x<=maxX;x++){
        const u=len?Math.max(0,Math.min(1,((x-ax)*vx+(y-ay)*vy)/len)):0;
        const dx=x-ax-u*vx,dy=y-ay-u*vy,coverage=Math.max(0,Math.min(1,2.25-Math.sqrt(dx*dx+dy*dy)));
        if(coverage){const ink=8+Math.min(3,Math.round(coverage*3)),at=y*(width+1)+x+1;if(pixels[at]<ink)pixels[at]=ink;}
      }
      previous=current;
    }
  }
  const domain=SOCIAL_MASKS.domain;
  mask(domain,(width-domain.a)/2,548+shift);
  text(date,'t',584+shift,'muted');
  // Native DEFLATE avoids JavaScript packing/checksum loops and keeps images small.
  const z=new Uint8Array(await new Response(new Response(pixels).body.pipeThrough(new CompressionStream('deflate'))).arrayBuffer());
  const uint32=(bytes,at,n)=>{bytes[at]=n>>>24;bytes[at+1]=n>>>16;bytes[at+2]=n>>>8;bytes[at+3]=n;};
  let pos=0;
  const ihdr=new Uint8Array(13);uint32(ihdr,0,width);uint32(ihdr,4,height);ihdr[8]=8;ihdr[9]=3;
  const chunks=[['IHDR',ihdr],['PLTE',palette],['IDAT',z],['IEND',new Uint8Array(0)]];
  const png=new Uint8Array(8+chunks.reduce((n,[,data])=>n+data.length+12,0));png.set([137,80,78,71,13,10,26,10]);pos=8;
  for(const [type,data]of chunks){uint32(png,pos,data.length);for(let i=0;i<4;i++)png[pos+4+i]=type.charCodeAt(i);png.set(data,pos+8);let crc=0xffffffff;for(let i=pos+4;i<pos+8+data.length;i++)crc=(crc>>>8)^SOCIAL_CRC[(crc^png[i])&255];uint32(png,pos+8+data.length,(crc^0xffffffff)>>>0);pos+=data.length+12;}
  return png;
}
const SOCIAL_CRC=Uint32Array.from({length:256},(_,n)=>{for(let k=0;k<8;k++)n=(n>>>1)^((n&1)?0xedb88320:0);return n>>>0;});
