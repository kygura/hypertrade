import { useParams } from 'react-router'
import { CoinDecision } from './CoinDecision'

export function CoinPage() {
  const { coin = '' } = useParams()
  return <CoinDecision coin={coin} />
}
