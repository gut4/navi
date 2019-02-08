import { Matcher, MatcherGenerator, MatcherGeneratorClass } from './Matcher'
import { createRootMapping, mappingAgainstPathname, Mapping } from './Mapping'
import { SegmentListObservable } from './SegmentListObservable'
import { SegmentsMapObservable } from './SegmentsMapObservable'
import { Resolver } from './Resolver'
import { Route, defaultRouteReducer } from './Route'
import { Segment } from './Segments'
import { SiteMap, RouteMap } from './Maps'
import { createPromiseFromObservable } from './Observable';
import { createURLDescriptor, URLDescriptor } from './URLTools';
import { createRequest, HTTPMethod } from './NaviRequest';
import { OutOfRootError } from './Errors';
import { Env } from './Env';
import { Reducer } from './Reducer';


export interface RouterOptions<Context extends object, R = Route> {
    context?: Context,
    routes?: Matcher<Context>,
    basename?: string,
    reducer?: Reducer<Segment, R>,
}

export interface RouterResolveOptions {
    followRedirects?: boolean,
    body?: any,
    headers?: { [name: string]: string },
    method?: HTTPMethod,
    hostname?: string,
}

export interface RouterMapOptions {
    followRedirects?: boolean,
    maxDepth?: number,
    predicate?: (segment: Segment) => boolean,
    expandPattern?: (pattern: string, router: Router) => undefined | string[] | Promise<undefined | string[]>,
    method?: 'GET' | 'HEAD',
    headers?: { [name: string]: string },
    hostname?: string,
}
  

// The public factory function creates a resolver.
export function createRouter<Context extends object>(options: RouterOptions<Context>){
    return new Router(options)
}

export class Router<Context extends object=any, R=Route> {
    private resolver: Resolver
    private context: Context
    private matcherGeneratorClass: MatcherGeneratorClass<Context>
    private rootMapping: Mapping
    private reducer: Reducer<Segment, R>
    
    constructor(options: RouterOptions<Context, R>) {
        this.resolver = new Resolver
        this.context = options.context || {} as any
        this.matcherGeneratorClass = options.routes!()
        this.reducer = options.reducer || (defaultRouteReducer as any)

        let basename = options.basename
        if (basename && basename.slice(-1) === '/') {
            basename = basename.slice(0, -1)
        }

        this.rootMapping = createRootMapping(options.routes!, basename)
    }

    // Please don't document this API. It should only be used through
    // "createBrowserNavigation()" or "createMemoryNavigation()"
    setContext(context: Context) {
        this.context = context || {}
    }

    createObservable(urlOrDescriptor: string | Partial<URLDescriptor>, options: RouterResolveOptions = {}): SegmentListObservable | undefined {
        // need to somehow keep track of which promises in the resolver correspond to which observables,
        // so that I don't end up updating observables which haven't actually changed.
        let url = createURLDescriptor(urlOrDescriptor, { removeHash: true })
        let rootEnv: Env = {
            context: this.context,
            request: createRequest(this.context, {
                body: options.body,
                headers: options.headers || {},
                method: options.method || 'GET',
                hostname: options.hostname || '',
                mountpath: '',
                params: url.query,
                query: url.query,
                search: url.search,
                router: this,
                url: url.pathname+url.search,
                originalUrl: url.href,
                path: url.pathname,
            })
        }
        let matchEnv = mappingAgainstPathname(rootEnv, this.rootMapping, true)
        if (matchEnv) {
            return new SegmentListObservable(
                url,
                matchEnv,
                this.matcherGeneratorClass,
                this.resolver
            )
        }
    }

    createMapObservable(urlOrDescriptor: string | Partial<URLDescriptor>, options: RouterMapOptions = {}): SegmentsMapObservable {
        return new SegmentsMapObservable(
            createURLDescriptor(urlOrDescriptor, { ensureTrailingSlash: false }),
            this.context,
            this.matcherGeneratorClass,
            this.rootMapping,
            this.resolver,
            this,
            options,
        )
    }

    resolve(url: string | Partial<URLDescriptor>, options?: RouterResolveOptions): Promise<R>;
    resolve(urls: (string | Partial<URLDescriptor>)[], options?: RouterResolveOptions): Promise<R[]>;
    resolve(urls: string | Partial<URLDescriptor> | (string | Partial<URLDescriptor>)[], options: RouterResolveOptions = {}): Promise<R | R[]> {
        let urlDescriptors: URLDescriptor[] = getDescriptorsArray(urls)
        if (!urlDescriptors.length) {
            return Promise.resolve([])
        }

        let promises = urlDescriptors.map(url => this.getPageRoutePromise(url, options))
        return !Array.isArray(urls) ? promises[0] : Promise.all(promises)
    }

    resolveSiteMap(urlOrDescriptor: string | Partial<URLDescriptor>, options: RouterMapOptions = {}): Promise<SiteMap<R>> {
        return createPromiseFromObservable(this.createMapObservable(urlOrDescriptor, options)).then(segmentsMap => {
            let routeMap = {} as RouteMap<R>
            let redirectMap = {} as { [name: string]: string }
            let urls = Object.keys(segmentsMap)
            for (let i = 0; i < urls.length; i++) {
                let url = urls[i]
                let segments = segmentsMap[url]
                let lastSegment = segments[segments.length - 1]
                if (lastSegment.type === 'redirect') {
                    redirectMap[url] = lastSegment.to
                    continue
                }
                else {
                    routeMap[url] =
                        [{ type: 'url', url: createURLDescriptor(url) }]
                            .concat(segments)
                            .reduce(this.reducer, undefined)!
                }
            }
            return {
                routes: routeMap,
                redirects: redirectMap,
            }
        })
    }

    resolveRouteMap(urlOrDescriptor: string | Partial<URLDescriptor>, options: RouterMapOptions = {}): Promise<RouteMap<R>> {
        return this.resolveSiteMap(urlOrDescriptor, options).then(siteMap => siteMap.routes)
    }

    private getPageRoutePromise(url: URLDescriptor, options: RouterResolveOptions): Promise<R> {
        let observable = this.createObservable(url, options)
        if (!observable) {
            return Promise.reject(new OutOfRootError(url))
        }

        return createPromiseFromObservable(observable).then(segments => {
            for (let i = 0; i < segments.length; i++) {
                let segment = segments[i]
                if (segment.type === 'busy') {
                    break
                }
                if (segment.type === 'redirect' && options.followRedirects) {
                    return this.getPageRoutePromise(createURLDescriptor(segment.to), options)
                }
                if (segment.type === 'error') {
                    throw segment.error
                }
            }

            return (
                [{ type: 'url', url: createURLDescriptor(url) }]
                    .concat(segments)
                    .reduce(this.reducer, undefined)!
            )
        })
    }
}

function getDescriptorsArray(urls: Partial<URLDescriptor> | string | (Partial<URLDescriptor> | string)[]): URLDescriptor[] {
    return Array.isArray(urls)
        ? urls.map(url => createURLDescriptor(url))
        : [createURLDescriptor(urls)]
}
