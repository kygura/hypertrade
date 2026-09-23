import { Link } from 'react-router'
import { Badge } from '../Badge'
import { ErrorBlock } from '../state'
import type { Answer, DecisionRecord, Intent, Question } from '../../../shared/strategy-protocol'
import { ProbBar } from './ProbBar'
import { ScoreRubric } from './ScoreRubric'
import { NoulBar } from './NoulBar'
import { IntentRow } from './IntentRow'
import { fmtProb, fmtTsSec } from './format'

// DecisionView — one DecisionRecord rendered in full: meta line, every
// question with its instructions and typed answer (ProbBar per option for
// choice, ScoreRubric for score, NoulBar for noul), confidence, then the
// intents with their verdict timelines. Used inline on /strategies/:id after
// a dry run and as the body of /decisions/:id.

function QuestionBlock({ id, question, answer }: { id: string; question: Question | undefined; answer: Answer | undefined }) {
  const instructions = question?.instructions ?? id
  const confidence = answer && answer.type !== 'noul' ? answer.confidence : undefined
  return (
    <div className="flex flex-col gap-2 py-3 border-b border-border-subtle last:border-b-0">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="label">{id}</span>
        <span className="text-[10px] uppercase tracking-wider text-text-secondary">{answer?.type ?? question?.type ?? '?'}</span>
        {confidence != null && (
          <span className="ml-auto text-[10px] tabular text-text-secondary" title="model confidence">
            CONF {fmtProb(confidence)}
          </span>
        )}
      </div>
      <p className="text-[12px] text-text-muted">{instructions}</p>

      {!answer && <span className="text-[11px] uppercase tracking-wider text-text-secondary">no answer</span>}

      {answer?.type === 'choice' && (
        <div className="flex flex-col gap-1">
          {Object.entries(answer.probabilities)
            .sort((a, b) => b[1] - a[1])
            .map(([opt, p]) => (
              <ProbBar
                key={opt}
                label={opt}
                p={p}
                chosen={opt === answer.choice}
                hint={question?.type === 'choice' ? question.criteria[opt] : undefined}
              />
            ))}
        </div>
      )}

      {answer?.type === 'score' && (
        <ScoreRubric
          score={answer.score}
          criteria={question?.type === 'score' ? question.criteria : []}
          probabilities={answer.probabilities}
          legend={answer.legend}
        />
      )}

      {answer?.type === 'noul' && <NoulBar value={answer.noul} />}
    </div>
  )
}

export function DecisionMeta({ decision, linkStrategy = true }: { decision: DecisionRecord; linkStrategy?: boolean }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] tabular text-text-secondary">
      <span className="text-text-muted">{fmtTsSec(decision.ts)}</span>
      {linkStrategy ? (
        <Link to={`/strategies/${decision.strategy_id}`} className="text-text-primary hover:underline">
          {decision.strategy_id}
        </Link>
      ) : (
        <span className="text-text-primary">{decision.strategy_id}</span>
      )}
      <span>{decision.venue}</span>
      {decision.dry_run && <Badge tone="info">DRY RUN</Badge>}
      {decision.model && <span>{decision.model}</span>}
      {decision.latency_ms != null && <span>{decision.latency_ms}ms</span>}
      {decision.usage && (
        <span>
          {decision.usage.input_tokens}→{decision.usage.output_tokens} tok
        </span>
      )}
      {decision.state_digest && (
        <span title={decision.state_digest} className="truncate max-w-[16ch]">
          {decision.state_digest}
        </span>
      )}
    </div>
  )
}

export function DecisionView({
  decision,
  busy = false,
  onApprove,
  onReject,
}: {
  decision: DecisionRecord
  busy?: boolean
  onApprove?: (intent: Intent) => void
  onReject?: (intent: Intent) => void
}) {
  const questionIds = Array.from(new Set([...Object.keys(decision.questions), ...Object.keys(decision.answers)]))
  return (
    <div className="flex flex-col gap-3">
      {decision.error && <ErrorBlock message={decision.error} />}

      <div className="panel">
        <div className="panel-header">
          <span className="panel-title">QUESTIONS</span>
          <span className="text-[10px] text-text-secondary tabular">{questionIds.length}</span>
        </div>
        <div className="panel-body px-3">
          {questionIds.length === 0 && (
            <div className="py-6 text-center text-[11px] uppercase tracking-wider text-text-secondary">no questions</div>
          )}
          {questionIds.map((id) => (
            <QuestionBlock key={id} id={id} question={decision.questions[id]} answer={decision.answers[id]} />
          ))}
        </div>
      </div>

      <div className="panel">
        <div className="panel-header">
          <span className="panel-title">INTENTS</span>
          <span className="text-[10px] text-text-secondary tabular">{decision.intents.length}</span>
        </div>
        <div className="panel-body px-3">
          {decision.intents.length === 0 && (
            <div className="py-6 text-center text-[11px] uppercase tracking-wider text-text-secondary">
              {decision.error ? 'no intents — decision errored' : 'no intents — hold'}
            </div>
          )}
          {decision.intents.map((intent) => (
            <IntentRow
              key={intent.id}
              intent={intent}
              verdicts={decision.verdicts}
              dryRun={decision.dry_run}
              busy={busy}
              onApprove={onApprove}
              onReject={onReject}
            />
          ))}
        </div>
      </div>

      {decision.state !== undefined && decision.state !== null && (
        <details className="panel">
          <summary className="panel-header cursor-pointer select-none">
            <span className="panel-title">STATE SENT TO JEV</span>
          </summary>
          <pre className="panel-body p-3 text-[10px] text-text-muted whitespace-pre-wrap break-all">
            {JSON.stringify(decision.state, null, 2)}
          </pre>
        </details>
      )}
    </div>
  )
}
