import math, random, pathlib
root=pathlib.Path(__file__).resolve().parents[2] / 'public' / 'sky'; root.mkdir(exist_ok=True)
def encode(v):
 m=max(v)
 if m<1e-32:return (0,0,0,0)
 _,e=math.frexp(m);s=256.0/(2**e)
 return tuple(min(255,max(0,int(c*s))) for c in v)+(e+128,)
def hdr(path,w,h,pixel):
 with path.open('wb') as f:
  f.write(f'#?RADIANCE\n# Original cloudless sky radiance for SILENCE\nFORMAT=32-bit_rle_rgbe\n\n-Y {h} +X {w}\n'.encode())
  for y in range(h):
   row=[encode(pixel(x,y,w,h)) for x in range(w)];f.write(bytes((2,2,w>>8,w&255)))
   for ch in range(4):
    values=[p[ch] for p in row];i=0
    while i<w:
     run=1
     while i+run<w and values[i+run]==values[i] and run<127:run+=1
     if run>=4:f.write(bytes((128+run,values[i])));i+=run
     else:
      start=i;i+=run
      while i<w and i-start<128:
       n=1
       while i+n<w and values[i+n]==values[i] and n<4:n+=1
       if n>=4:break
       i+=min(n,128-(i-start))
      f.write(bytes((i-start,)));f.write(bytes(values[start:i]))
def day(x,y,w,h):
 elevation=math.cos((y+.5)/h*math.pi)
 if elevation<0:
  a=math.exp(elevation*10);return (.021+.18*a,.027+.22*a,.032+.25*a)
 # Rayleigh-dominated blue zenith, long path near-white horizon. No baked sun.
 t=elevation**.45
 return tuple((1-t)*a+t*b for a,b in zip((.72,.86,1.0),(.11,.28,.61)))
# Star points now live in game/render/world/sky.ts and resolve at framebuffer resolution.
# The original radiance panorama supplies only diffuse starlight / Milky Way.
w,h=2048,1024
def night(x,y,w,h):
 elev=math.cos((y+.5)/h*math.pi);phi=(x+.5)/w*math.tau
 # Very subtle Milky Way, oriented away from terrestrial horizon; fixed stars rotate in shader.
 latitude=abs(elev*.68+math.sqrt(max(0,1-elev*elev))*math.cos(phi)*.73)
 band=math.exp(-latitude*latitude*80)*.0018
 return tuple(b+band for b in (.0005,.001,.0022))
hdr(root/'cloudless-day.hdr',1024,512,day);hdr(root/'starfield-night.hdr',w,h,night)
