process.once('message', (input: { snapshot: { content: { title: string } } }) => {
  const mode = input.snapshot.content.title;
  if (mode === 'crash') process.exit(88);
  if (mode === 'hang') {
    setInterval(() => {}, 1000);
    return;
  }
  if (mode === 'environment' && process.env.OFFICE_TEST_SECRET) process.exit(77);
  const reply =
    mode === 'invalid'
      ? { ok: true, value: {} }
      : {
          ok: true,
          value: { bytes: Buffer.from([80, 75, 3, 4, 5]), pages: mode === 'mismatch' ? 1 : null },
        };
  if (mode === 'duplicate') {
    process.send?.(reply, () => process.send?.(reply, () => process.exit(0)));
  } else process.send?.(reply, () => process.exit(0));
});
