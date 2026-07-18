import type { RouteObject } from 'react-router'
import { RouteErrorElement } from './components/ErrorBoundary'
import { Layout } from './components/Layout'
import { Landing } from './routes/landing/LandingPage'
import { Library } from './routes/library/LibraryPage'
import { NotFound } from './routes/not-found'
import { Reader } from './routes/reader/ReaderPane'
import { Settings } from './routes/settings/SettingsPage'

export const routes: RouteObject[] = [
  {
    path: '/',
    element: <Layout />,
    errorElement: <RouteErrorElement />,
    children: [
      { index: true, element: <Landing /> },
      { path: 'library', element: <Library /> },
      { path: 'reader', element: <Reader /> },
      { path: 'reader/:bookId', element: <Reader /> },
      { path: 'settings', element: <Settings /> },
      { path: '*', element: <NotFound /> },
    ],
  },
]
