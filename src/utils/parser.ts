export function parseTimestamps(script: string): number[] {
  if (!script || !script.trim()) return [];

  // Replace any en-dashes or em-dashes with standard hyphens before parsing
  script = script.replace(/[\u2013\u2014\u2212]/g, '-');

  const timeToSeconds = (s: string) => {
    s = s.replace(',', '.');
    const partsByDot = s.split('.');
    if (partsByDot.length > 2) {
      const decimal = partsByDot.pop();
      s = partsByDot.join(':') + '.' + decimal;
    }
    const parts = s.split(':');
    let total = 0;
    if (parts.length === 3) {
      total = parseInt(parts[0], 10) * 3600 + parseInt(parts[1], 10) * 60 + parseFloat(parts[2]);
    } else if (parts.length === 2) {
      total = parseInt(parts[0], 10) * 60 + parseFloat(parts[1]);
    } else if (parts.length === 1) {
      total = parseFloat(parts[0]);
    }
    return total;
  };

  const tsPattern = /(?:\d+[:.])+\d+(?:[.,]\d+)?|\d+[.,]\d+/;
  const rangePattern = new RegExp(`(${tsPattern.source})\\s*(?:-+|-->|->)\\s*(${tsPattern.source})`, 'g');
  
  const rangeMatches = [...script.matchAll(rangePattern)];
  if (rangeMatches.length > 0) {
    const segments = rangeMatches.map(match => {
      return {
        startTotal: timeToSeconds(match[1]),
        endTotal: timeToSeconds(match[2])
      };
    });

    const durations: number[] = [];
    for (let i = 0; i < segments.length; i++) {
      let duration = 0;
      if (i < segments.length - 1) {
        duration = segments[i+1].startTotal - segments[i].startTotal;
      } else {
        duration = segments[i].endTotal - segments[i].startTotal;
      }
      durations.push(Math.max(0, Number(duration.toFixed(3))));
    }
    return durations;
  }

  // Fallback to single timestamps
  const timeRegex = new RegExp(tsPattern, 'g');
  const matches = [...script.matchAll(timeRegex)];
  
  if (matches.length === 0) return [];

  const timesInSeconds = matches.map(m => timeToSeconds(m[0]));
  timesInSeconds.sort((a, b) => a - b);
  
  if (timesInSeconds.length === 1) {
    return [Math.max(0, Number(timesInSeconds[0].toFixed(3)))];
  }

  const durations: number[] = [];
  for (let i = 0; i < timesInSeconds.length - 1; i++) {
    durations.push(Math.max(0, Number((timesInSeconds[i + 1] - timesInSeconds[i]).toFixed(3))));
  }
  
  return durations;
}
