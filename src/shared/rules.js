/**
 * Participant-facing rule of each phase, as seen by one player. Mirrors
 * computeVoiceParams in mapping.js; keep the two in step.
 *
 * Each row reads "actor + gesture → effect": actor is 'you', 'partner' or
 * 'both'; effect is 'pitch', 'rhythm', 'brightness' or 'joint'.
 * Phases without a rule (idle, latency-test) return null.
 */
export function playerRules(phase, me, divisionSwap = false) {
  const ownPitch = { actor: 'you', gesture: 'tilt', effect: 'pitch', text: 'Tilt to change your pitch' };
  const ownRhythm = { actor: 'you', gesture: 'shake', effect: 'rhythm', text: 'Shake harder for more notes' };

  switch (phase) {
    case 'familiarization':
      return {
        title: 'Your own sound',
        summary: 'Your phone follows only your movement.',
        rows: [ownPitch, ownRhythm],
      };
    case 'division': {
      const title = 'One shared sound';
      if (me === (divisionSwap ? 1 : 0)) {
        return {
          title,
          summary: 'You choose the notes; your partner sets how many.',
          rows: [
            { actor: 'you', gesture: 'tilt', effect: 'pitch', text: 'Your tilt sets the pitch on both phones' },
            { actor: 'partner', gesture: 'shake', effect: 'rhythm', text: 'Your partner’s shaking sets the rhythm on both phones' },
          ],
        };
      }
      return {
        title,
        summary: 'Your partner chooses the notes; you set how many.',
        rows: [
          { actor: 'partner', gesture: 'tilt', effect: 'pitch', text: 'Your partner’s tilt sets the pitch on both phones' },
          { actor: 'you', gesture: 'shake', effect: 'rhythm', text: 'Your shaking sets the rhythm on both phones' },
        ],
      };
    }
    case 'modulation':
      return {
        title: 'Shape each other',
        summary: 'You play your own notes; your partner colors them.',
        rows: [
          ownPitch,
          ownRhythm,
          { actor: 'partner', gesture: 'shake', effect: 'brightness', text: 'The more your partner shakes, the brighter your sound — and yours brightens theirs' },
        ],
      };
    case 'consensus':
      return {
        title: 'Move together',
        summary: 'Your own sound, plus a shared one when you move in time.',
        rows: [
          ownPitch,
          ownRhythm,
          { actor: 'both', gesture: 'shake', effect: 'joint', text: 'Shake at the same moment: a shared bell joins in and your own sounds soften' },
        ],
      };
    default:
      return null;
  }
}

export default playerRules;
