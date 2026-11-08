/** Semantic colors shared by the offline report and generated repository artwork. */
export const REPORT_THEME = {
  dark: { bg: '#0B0E14', panel: '#11151D', line: '#303B4B', fg: '#E6EDF3', mut: '#A2ADBA', dim: '#929EAE', amber: '#E0A93B', green: '#72BE8D', rust: '#E18E79', blue: '#84B5DE', violet: '#B4A2DC' },
  light: { bg: '#F4F6F9', panel: '#FFFFFF', line: '#CDD4DE', fg: '#172335', mut: '#4D5D71', dim: '#56667A', amber: '#835807', green: '#22653D', rust: '#9C3E2C', blue: '#245F91', violet: '#695093' },
} as const;

export const REPORT_THEME_CSS = Object.entries(REPORT_THEME).map(([mode, tokens]) => {
  const rules = ':root{color-scheme:' + mode + ';' + Object.entries(tokens).map(([key, value]) => '--' + key + ':' + value).join(';') + '}';
  return mode === 'dark' ? rules : '@media(prefers-color-scheme:light){' + rules + '}';
}).join('\n');
