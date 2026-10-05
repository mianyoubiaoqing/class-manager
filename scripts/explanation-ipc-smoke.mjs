import { strict as assert } from 'node:assert';

/** Exercises real IPC, crypto, worker and storage with a synthetic, non-network transport. */
export async function exerciseExplanationIpc(application, page, epoch, versionId, subjectId) {
  await application.evaluate(() => {
    globalThis.__cmBeforeExplanationFetch = globalThis.fetch;
    globalThis.__cmExplanationCalls = 0;
    globalThis.fetch = async (_url, init) => {
      globalThis.__cmExplanationCalls++;
      const body = JSON.parse(init.body);
      const wire = JSON.parse(body.messages[1].content);
      if (
        JSON.stringify(wire).includes('合成') ||
        Object.keys(wire).sort().join(',') !== 'facts,formatVersion,scope'
      )
        throw new Error('Unexpected outbound explanation fields');
      return new Response(
        JSON.stringify({
          id: 'synthetic-desktop-generation',
          model: 'deepseek-flash',
          choices: [
            {
              finish_reason: 'stop',
              message: {
                content: JSON.stringify({
                  formatVersion: 1,
                  observations: wire.facts.map(({ id, value }) => ({ factId: id, value })),
                  interpretations: [],
                  questions: [],
                  actions: [],
                  limitations: ['合成响应，无题目级资料'],
                }),
              },
            },
          ],
          usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    };
  });
  try {
    assert.equal(
      (
        await page.evaluate(() =>
          window.classManager.saveDeepSeekKey({ apiKey: 'synthetic-desktop-explanation-key' }),
        )
      ).ok,
      true,
    );
    const prepared = await page.evaluate((input) => window.classManager.prepareExplanation(input), {
      epoch,
      sourceVersionId: versionId,
      selection: {
        subjectIds: [subjectId],
        metrics: ['fullScore', 'validCount', 'mean'],
        scope: { kind: 'class' },
      },
    });
    assert.equal(prepared.ok, true, JSON.stringify(prepared));
    const command = { epoch, token: prepared.value.token };
    const generated = await page.evaluate(
      (input) => window.classManager.generateExplanation(input),
      command,
    );
    assert.equal(generated.ok, true, JSON.stringify(generated));
    const id = generated.value.id;
    const view = await page.evaluate((input) => window.classManager.readExplanation(input), {
      epoch,
      id,
    });
    assert.equal(view.ok, true, JSON.stringify(view));
    const edited = await page.evaluate((input) => window.classManager.editExplanation(input), {
      epoch,
      id,
      expectedRevision: 1,
      content: { ...view.value.payload.content, teacherNotes: '合成教师复核' },
    });
    assert.equal(edited.value.revision, 2);
    const discarded = await page.evaluate(
      (input) => window.classManager.discardExplanation(input),
      { epoch, id, expectedRevision: 2 },
    );
    assert.equal(discarded.value.status, 'discarded');
    const retried = await page.evaluate(
      (input) => window.classManager.generateExplanation(input),
      command,
    );
    assert.equal(retried.ok, false);
    assert.equal(await application.evaluate(() => globalThis.__cmExplanationCalls), 1);
    const ledger = await page.evaluate(() => window.classManager.getDeepSeekLedger());
    assert.equal(ledger.value.recentEntries[0].type, 'score_explanation');
    assert.equal(ledger.value.recentEntries[0].usage.totalTokens, 150);
    return id;
  } finally {
    await page.evaluate(() => window.classManager.deleteDeepSeekKey());
    await application.evaluate(() => {
      globalThis.fetch = globalThis.__cmBeforeExplanationFetch;
      delete globalThis.__cmBeforeExplanationFetch;
    });
  }
}
