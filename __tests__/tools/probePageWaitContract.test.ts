/**
 * probe_page's WAIT CONTRACT — what the tool tells a model to do (sentinal-kvoou).
 *
 * The schema a model reads IS the advice it follows. probe_page used to say:
 *
 *     "Default 'load'. Use 'networkidle' for SPAs to wait until the bundle
 *      finishes rendering."
 *
 * Both halves are wrong, and the second is wrong about exactly the class of app it
 * names. Every live application has continuous traffic — analytics beacons, polling,
 * websockets, SSE, prefetch, heartbeats, ad calls — so "the network went quiet" is a
 * state that never arrives on a real SPA, and waiting for it can only end in the
 * wait's own timeout. And 'load' blocks on every sub-resource including third-party
 * iframes and images we do not control.
 *
 * Measured 2026-08-19 against https://debugg.ai, which carries two cross-origin
 * YouTube embeds: the default 'load' probe returned
 *   TimeoutError: Page.goto: Timeout 10000ms exceeded ... waiting until "load"
 * with statusCode 0 after burning the full 10s budget, on a page that renders fine.
 * The same page on 'domcontentloaded' returned statusCode 200 with the correct title
 * in 3550ms.
 *
 * So: the tool must not RECOMMEND network idle, and must not DEFAULT to 'load'.
 * The value stays in the enum because this package is published — see the schema
 * test for why neutralize beats remove.
 */
import { buildProbePageTool } from '../../tools/probePage.js';
import { ProbePageInputSchema } from '../../types/index.js';

describe('probe_page wait contract', () => {
  const tool = buildProbePageTool();
  const props = (tool.inputSchema as any).properties.targets.items.properties;
  const waitDesc: string = props.waitForLoadState.description;

  it('never recommends networkidle', () => {
    expect(waitDesc.toLowerCase()).not.toContain("use 'networkidle'");
    expect(waitDesc).not.toMatch(/use\s+["'`]?networkidle/i);
  });

  it('states that networkidle is accepted but not honoured', () => {
    // A schema that lies to the model is how the bad advice propagates. If the value
    // is still offered, the description has to say what actually happens.
    expect(waitDesc).toContain('networkidle');
    expect(waitDesc.toLowerCase()).toMatch(/never (issued|waited)|not (issued|honou?red)/);
  });

  it('does not present load as the default', () => {
    expect(waitDesc).not.toMatch(/default\s+'load'/i);
    expect(waitDesc.toLowerCase()).toContain('domcontentloaded');
  });

  it('warns that load blocks on third-party sub-resources', () => {
    expect(waitDesc.toLowerCase()).toMatch(/third-party|iframe|sub-resource/);
  });

  it('the documented default matches the schema default a caller actually gets', () => {
    const parsed = ProbePageInputSchema.parse({ targets: [{ url: 'https://debugg.ai' }] });
    expect(parsed.targets[0].waitForLoadState).toBe('domcontentloaded');
  });

  it('keeps every enum value the published package already accepts', () => {
    // Removing 'networkidle' would break existing callers with a hard validation
    // error. Neutralizing it gives them the result they were reaching for.
    expect(props.waitForLoadState.enum).toEqual(
      expect.arrayContaining(['load', 'domcontentloaded', 'networkidle']),
    );
  });
});
