// Known file versions for the crash test. Large enough (~300-600 KB) that a kill
// often lands mid-write; distinct lengths so a torn write can't look like a valid version.
export const versions = [0, 1, 2, 3].map(i =>
  `# Version ${i}\n\n` + `line ${i} ünïcode 漢字 — ${'x'.repeat(40)}\n`.repeat(5000 + i * 2500)
)
