import { Component, type ReactNode } from 'react'
import { Button } from './Button'

// A render throw in a routed page shows this instead of unmounting the app.
// RETRY remounts the children.
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null; attempt: number }> {
  state = { error: null as Error | null, attempt: 0 }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  render() {
    const { error, attempt } = this.state
    if (!error)
      return (
        <div key={attempt} className="contents">
          {this.props.children}
        </div>
      )
    return (
      <div role="alert" className="flex flex-col items-start gap-2 p-4 text-[12px]">
        <span className="text-text-primary">This page crashed: {error.message}</span>
        <Button tier="neutral" onClick={() => this.setState((s) => ({ error: null, attempt: s.attempt + 1 }))}>
          RETRY
        </Button>
      </div>
    )
  }
}
