# Local Development Test Accounts

These accounts are seeded only when OrderFood creates a fresh local database. They are for
local coursework/testing only. Do not deploy them or reuse these passwords for real accounts.

| Email | Password | Role |
|---|---|---|
| alice.customer@example.com | AlicePass123! | Customer |
| anna.admin@example.com | AnnaAdmin123! | Restaurant admin (Annapurna Meals) |
| david.agent@example.com | DavidAgent123! | Delivery agent |
| customer@test.com | password123 | Customer |
| admin@test.com | admin123 | Restaurant admin (The Burger Joint) |

Existing databases are not overwritten on startup. Delete the local `orderfood.db` only when
you intentionally want to recreate a clean demo database.
