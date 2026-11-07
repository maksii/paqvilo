# Security policy

Security fixes target the latest published Paqvilo release. Upgrade before reproducing a report; older releases do not have a separate maintenance guarantee.

Report suspected vulnerabilities through [GitHub private vulnerability reporting](https://github.com/maksii/paqvilo/security/advisories/new). Include the Paqvilo/Node/browser versions, affected Lense or Mirage workflow, expected security boundary, impact and minimal synthetic reproduction. Do not post exploit details in a public issue before a fix is coordinated. Response times depend on maintainer availability.

Never attach portal exports, bearer tokens, session discovery, cookies, credentials or live captures. Keep `.paqvilo/` and personal configuration private. Lense browser interactions can affect live data; Mirage handlers and explicitly registered data packs are trusted local code. Use loopback fixtures for toolkit security tests.

Ownership state directories and their parents must remain under trusted control while Paqvilo uses them. Cooperating Paqvilo publishers are supported; another actor replacing directories or entries during cleanup is outside this boundary. Descriptor, digest and pathname checks detect many stale or linked replacements, but Node's portable pathname-based unlink does not atomically delete only a previously checked inode. These checks are not a sandbox against hostile concurrent filesystem mutation. Directory mode bits alone do not establish Windows ACL isolation.
