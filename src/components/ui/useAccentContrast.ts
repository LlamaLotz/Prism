import { useEffect } from 'react';
/** Choose black or white using the rendered accent, including custom accents. */
export function useAccentContrast() {
 useEffect(()=>{const root=document.documentElement;const sample=document.createElement('span');sample.style.cssText='position:fixed;visibility:hidden;color:var(--color-brand-400);pointer-events:none';document.body.append(sample);
 const update=()=>{const rgb=getComputedStyle(sample).color.match(/[\d.]+/g)?.slice(0,3).map(Number);if(!rgb||rgb.length<3)return;const linear=rgb.map(c=>{const s=c/255;return s<=.04045?s/12.92:((s+.055)/1.055)**2.4;});const luminance=linear[0]*.2126+linear[1]*.7152+linear[2]*.0722;const ink=luminance>.179?'#000000':'#ffffff';if(root.style.getPropertyValue('--nb-accent-ink')!==ink)root.style.setProperty('--nb-accent-ink',ink);};update();const observer=new MutationObserver(update);observer.observe(root,{attributes:true,attributeFilter:['class','style']});return()=>{observer.disconnect();sample.remove();};},[]);
}
