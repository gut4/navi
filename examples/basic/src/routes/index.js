import { map, route } from 'navi'

export default map({
  '/': route({
    title: 'Home',
    getView: () => import('./index.mdx')
  }),
    
  '/about': route({
    title: "About",
    getView: async () => {
      // This simulates some async content loading, so that
      // you can test the site's loading bar.
      await new Promise(resolve => setTimeout(resolve, 1000))

      return import('./about.mdx')
    }
  }),
})