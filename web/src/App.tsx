import type { RouteObject } from 'react-router'
import { Layout } from './components/Layout'
import { Landing } from './routes/landing'
import { Library } from './routes/library'
import { NotFound } from './routes/not-found'
import { Reader } from './routes/reader'
import { Settings } from './routes/settings'

export const routes: RouteObject[] = [
  {
    path: '/',
    element: <Layout />,
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
