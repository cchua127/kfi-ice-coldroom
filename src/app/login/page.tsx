'use client'

import { useActionState } from 'react'
import { signIn } from './actions'

export default function LoginPage() {
  const [error, action, pending] = useActionState(signIn, null)

  return (
    <main className="auth">
      <form action={action} className="card">
        <h1>KFI Ice Ops</h1>
        <p className="sub">Sign in to continue</p>

        <label htmlFor="email">Email</label>
        <input id="email" name="email" type="email" autoComplete="username" required autoFocus />

        <label htmlFor="password">Password (Kata laluan)</label>
        <input id="password" name="password" type="password" autoComplete="current-password" required />

        {error ? <p className="error" role="alert">{error}</p> : null}

        <button type="submit" disabled={pending}>
          {pending ? 'Signing in…' : 'Sign in'}
        </button>
        <p className="hint">
          Accounts are created by the administrator. There is no self-registration.
        </p>
      </form>
    </main>
  )
}
