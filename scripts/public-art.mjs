// Original geometric project artwork. No downloaded images, fonts, logos or model-generated source material.
export function mascot({ green = false, bob = 0 } = {}) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="360" height="640" viewBox="0 0 360 640">
  ${green ? '<path fill="#00ff00" d="M0 0h360v640H0z"/>' : ''}
  <g transform="translate(0 ${bob})" stroke="#183745" stroke-width="7" stroke-linejoin="round">
  <path fill="#9edfcf" d="M104 164L103 61l63 68m31 0 62-68-3 108"/>
  <rect x="107" y="251" width="146" height="252" rx="56" fill="#d8f1eb"/>
  <rect x="109" y="250" width="142" height="252" rx="56" fill="#d8f1eb" stroke="none"/>
  <rect x="113" y="469" width="54" height="90" rx="25" fill="#9edfcf"/>
  <rect x="194" y="469" width="54" height="90" rx="25" fill="#9edfcf"/>
  <rect x="73" y="276" width="42" height="139" rx="21" fill="#9edfcf" transform="rotate(8 95 290)"/>
  <rect x="245" y="276" width="42" height="139" rx="21" fill="#9edfcf" transform="rotate(-8 265 290)"/>
  <rect x="91" y="111" width="179" height="164" rx="65" fill="#d8f1eb"/>
  <path d="M146 181v15m68-15v15" stroke-linecap="round"/>
  <path d="M165 218q15 16 30 0" fill="none" stroke-linecap="round"/>
  <circle cx="126" cy="211" r="11" fill="#ffcbad" stroke="none"/><circle cx="235" cy="211" r="11" fill="#ffcbad" stroke="none"/>
  <path d="M180 344c-28-29-56 10 0 41 56-31 28-70 0-41" fill="#ed9678" stroke="none"/>
  <path d="M135 424h90" fill="none" stroke="#9edfcf" stroke-linecap="round"/>
  </g></svg>`.replace(/[ \t]+$/gm, '');
}
export function cover() {
  const pet = mascot().replace(/<svg[^>]+>/, '<g transform="translate(795 26) scale(.81)">').replace('</svg>', '</g>');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="640" viewBox="0 0 1280 640" role="img" aria-label="Quiet Companion: macOS desktop pet and AI agent; original illustration, not a screenshot">
  <defs><linearGradient id="bg"><stop stop-color="#edf5f2"/><stop offset="1" stop-color="#dcece6"/></linearGradient></defs>
  <rect width="1280" height="640" rx="32" fill="url(#bg)"/>
  <circle cx="1030" cy="294" r="250" fill="#ffffff" opacity=".6"/>
  <g font-family="-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif" fill="#183745">
  <text x="78" y="104" font-size="17" letter-spacing="4">A LITTLE PRESENCE. REAL WORK.</text>
  <text x="74" y="219" font-size="82" font-weight="700">栖伴</text>
  <text x="78" y="281" font-size="45" font-weight="650">Quiet Companion</text>
  <text x="80" y="345" font-size="23">macOS 桌宠 · 可选实时数字人 · AI 电脑任务</text>
  <text x="80" y="385" font-size="20" fill="#536e77">A desktop companion that can help get things done.</text>
  <g font-size="17"><rect x="80" y="438" width="128" height="43" rx="21" fill="#183745"/><text x="105" y="466" fill="#fff">macOS</text>
  <rect x="223" y="438" width="147" height="43" rx="21" fill="#fff"/><text x="248" y="466">Local pet</text>
  <rect x="385" y="438" width="149" height="43" rx="21" fill="#fff"/><text x="410" y="466">AI agent</text></g>
  <text x="80" y="566" font-size="15" fill="#607c81">Electron · React · TypeScript · WebGL / Original illustration</text></g>${pet}</svg>`;
}
