# POS-HISTORY-LOADER-001 (2026-11-28 09:30 JST)

Fixed parent PR170 730cbfbba131cb42dea2ea6f0555e080ba797470. The response JSON local named data shadows React Router's data response function. Normal GraphQL results therefore throw when returned as data(...), entering the existing500 catch. Rename only that JSON local to payload and its three references. UI, query, state, authentication, retry and all error branches stay unchanged.

The regression transpiles the actual exported loader, uses the installed React Router data function, and supplies a normal synthetic admin/GraphQL read seam. It does not exercise SDK authentication or make a network call. The exact-parent control expects normal+empty2 failures and404/GraphQL500 controls2 passes; candidate expects4 passes. Existing46 business fixtures plus whole type/lint/build observation retain all debt rather than claiming clean quality.

This candidate is isolated, not adopted/deployed. A route-source fix is not proof that the current history list links to this separate dynamic route: its inspected list uses fetcher/modal. Real Store, actual admin/browser navigation, devices, complete-pagination, physical paper, database recovery and POS-RENDER-003 are separate unverified scopes. No UI change or new permission interpretation is included.
