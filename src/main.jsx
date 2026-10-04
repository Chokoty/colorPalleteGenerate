import { StrictMode, Component } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'

class RootBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error) {
    console.error(error)
  }

  render() {
    if (this.state.error) {
      return (
        <p style={{ padding: 24 }}>
          화면을 표시하지 못했습니다. 새로고침한 뒤 다시 시도해 주세요.
        </p>
      )
    }
    return this.props.children
  }
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <RootBoundary>
      <App />
    </RootBoundary>
  </StrictMode>,
)
