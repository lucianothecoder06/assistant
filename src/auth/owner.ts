import type { Auth } from './auth.js'

/** Creates the owner user with an email/password credential, or resets the password if it exists. */
export async function upsertOwner(auth: Auth, email: string, password: string): Promise<'created' | 'updated'> {
  const ctx = await auth.$context
  const hash = await ctx.password.hash(password)
  const existing = await ctx.internalAdapter.findUserByEmail(email.toLowerCase(), { includeAccounts: true })

  if (existing) {
    const credential = existing.accounts.find((account) => account.providerId === 'credential')
    if (credential) await ctx.internalAdapter.updatePassword(existing.user.id, hash)
    else await ctx.internalAdapter.linkAccount({ userId: existing.user.id, providerId: 'credential', accountId: existing.user.id, password: hash })
    return 'updated'
  }

  const user = await ctx.internalAdapter.createUser(
    { email: email.toLowerCase(), name: 'Owner', emailVerified: true },
    { method: 'admin' },
  )
  await ctx.internalAdapter.linkAccount({ userId: user.id, providerId: 'credential', accountId: user.id, password: hash })
  return 'created'
}
