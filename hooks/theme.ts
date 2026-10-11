/**
 * The look: a green-phosphor CRT terminal. Every colour and the font of the drawn parts
 * (band, lanes, icons, status marks) and the hex colours of the pane's text come from here.
 */
export const CRT = {
  /** the tube, and the pane behind the graph */
  bg: '#050A06',
  /** phosphor at full beam: text, lines, outlines */
  green: '#33FF66',
  /** phosphor at low beam: hints, secondary text */
  dim: '#1F9F45',
  /** a faint wash of phosphor: fills behind text */
  faint: '#0F3D1A',
  /** amber phosphor: things waiting on you (push, changes) */
  amber: '#FFB000',
  /** cyan: things coming in (pull, review) */
  cyan: '#5CFFE0',
  red: '#FF5555',
  font: "'SF Mono',Menlo,Monaco,'Courier New',monospace",
} as const

/** Lane colours: shades of phosphor first, the warm and cold tubes after. */
export const LANE_COLORS = [CRT.green, CRT.amber, CRT.cyan, '#B6FF5C', CRT.dim, '#FF8C3A', '#7FFFB0', CRT.red]

/** Phosphor bloom: the shape, blurred once beneath itself. */
export const GLOW_FILTER =
  '<filter id="glow" x="-30%" y="-30%" width="160%" height="160%">' +
  '<feGaussianBlur stdDeviation="1.1" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>'

/** Scanlines: every third pixel row a little darker, laid over a whole image. */
export const SCANLINES =
  '<pattern id="scan" width="4" height="3" patternUnits="userSpaceOnUse"><rect width="4" height="1" fill="#000" fill-opacity=".28"/></pattern>'
