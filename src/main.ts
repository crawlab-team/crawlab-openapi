#!/usr/bin/env node

import {HttpClient, OpenAPIToMCPConverter} from 'openapi-mcp-server'
import {OpenAPIV3} from 'openapi-types'
import SwaggerParser from '@apidevtools/swagger-parser'
import {Command} from 'commander'

export async function loadSpec(specPath: string): Promise<OpenAPIV3.Document> {
    try {
        // Use swagger-parser to bundle the OpenAPI spec with all its references
        return await SwaggerParser.bundle(specPath) as OpenAPIV3.Document
    } catch (error) {
        console.error('Error bundling OpenAPI spec:', error)
        throw error
    }
}

// Generate mock response based on schema
function generateMockResponse(schema: any): any {
    if (!schema) return null

    // Handle schema references
    if (schema.$ref) {
        // For simplicity in mock mode, just return a placeholder
        return {"_mockRef": schema.$ref}
    }

    // Use example if provided
    if (schema.example) return schema.example

    // Handle oneOf, anyOf, allOf
    if (schema.oneOf) return generateMockResponse(schema.oneOf[0])
    if (schema.anyOf) return generateMockResponse(schema.anyOf[0])
    if (schema.allOf) {
        // Merge all schemas in allOf
        const result: Record<string, any> = {}
        schema.allOf.forEach((subSchema: any) => {
            const mockSubSchema = generateMockResponse(subSchema)
            if (typeof mockSubSchema === 'object' && mockSubSchema !== null) {
                Object.assign(result, mockSubSchema)
            }
        })
        return result
    }

    if (schema.type === 'object') {
        const result: Record<string, any> = {}
        if (schema.properties) {
            Object.entries(schema.properties).forEach(([key, prop]: [string, any]) => {
                result[key] = generateMockResponse(prop)
            })
        }
        return result
    } else if (schema.type === 'array') {
        // Generate 1-3 items for arrays
        const count = Math.floor(Math.random() * 3) + 1
        const result = []
        for (let i = 0; i < count; i++) {
            result.push(generateMockResponse(schema.items))
        }
        return result
    } else if (schema.type === 'string') {
        if (schema.enum) return schema.enum[0]
        if (schema.format === 'date-time') return new Date().toISOString()
        if (schema.format === 'date') return new Date().toISOString().split('T')[0]
        if (schema.format === 'email') return 'user@example.com'
        if (schema.format === 'uri') return 'https://example.com'
        if (schema.format === 'uuid') return '00000000-0000-0000-0000-000000000000'
        return 'mock-string'
    } else if (schema.type === 'number' || schema.type === 'integer') {
        if (schema.enum) return schema.enum[0]
        if (schema.minimum !== undefined && schema.maximum !== undefined) {
            return Math.floor(Math.random() * (schema.maximum - schema.minimum + 1)) + schema.minimum
        }
        return schema.type === 'integer' ? 42 : 42.5
    } else if (schema.type === 'boolean') {
        return true
    } else {
        return null
    }
}

async function main() {
    const program = new Command()

    program
        .name('openapi-client')
        .description('OpenAPI client tool for interacting with APIs')
        .version('1.0.0')

    program
        .requiredOption('-s, --spec <path>', 'Path to OpenAPI specification file')
        .option('-b, --base-url <url>', 'Specify the base URL for API calls')
        .option('-m, --mock', 'Use mock mode (no actual API calls)')

    program
        .command('list')
        .description('List all available methods')
        .action(async (options) => {
            const opts = program.opts()
            await executeList(opts.spec, opts.baseUrl, opts.mock)
        })

    program
        .command('call <method>')
        .description('Call a method with optional JSON params')
        .argument('[params]', 'JSON parameters for the method')
        .action(async (method, params, options) => {
            const opts = program.opts()
            await executeCall(opts.spec, method, params, opts.baseUrl, opts.mock)
        })

    program.parse()
}

async function executeList(specPath: string, baseUrlArg?: string, mockMode = false) {
    try {
        const spec = await loadSpec(specPath)
        const converter = new OpenAPIToMCPConverter(spec)

        // Get base URL from spec or use default/provided value
        const baseUrl = determineBaseUrl(spec, baseUrlArg)

        console.log(`Using base URL: ${baseUrl}${mockMode ? ' (MOCK MODE)' : ''}`)

        // List all available methods
        const {tools} = converter.convertToMCPTools()
        console.log('\nAvailable methods:')
        Object.entries(tools).forEach(([name, def]: [string, any]) => {
            def.methods.forEach((method: any) => {
                console.log(`  - ${method.name}: ${method.description}`)
            })
        })
    } catch (error: any) {
        handleError(error)
    }
}

async function executeCall(
    specPath: string,
    methodName: string,
    paramsJson?: string,
    baseUrlArg?: string,
    mockMode = false
) {
    try {
        // Parse parameters if provided
        const params = paramsJson ? JSON.parse(paramsJson) : {}

        const spec = await loadSpec(specPath)
        const converter = new OpenAPIToMCPConverter(spec)

        // Get base URL from spec or use default/provided value
        const baseUrl = determineBaseUrl(spec, baseUrlArg)

        console.log(`Using base URL: ${baseUrl}${mockMode ? ' (MOCK MODE)' : ''}`)

        const httpClient = new HttpClient({baseUrl}, spec)

        // Get operation details
        const {openApiLookup} = converter.convertToMCPTools()
        const operation = openApiLookup[methodName]
        if (!operation) {
            console.error(`Error: Method ${methodName} not found`)
            process.exit(1)
        }

        if (mockMode) {
            // Generate mock response based on the operation's response schema
            const successResponse = operation.responses['200'] ||
                operation.responses['201'] ||
                operation.responses['2XX'] ||
                Object.values(operation.responses)[0]

            if (successResponse && successResponse.content && successResponse.content['application/json']) {
                const schema = successResponse.content['application/json'].schema
                const mockData = generateMockResponse(schema)
                console.log('Mock Response:', JSON.stringify(mockData, null, 2))
            } else {
                console.log('Mock Response: Success (no schema defined for response)')
            }
        } else {
            try {
                // Execute the operation
                const response = await httpClient.executeOperation(operation, params)
                console.log('Response:', JSON.stringify(response.data, null, 2))
            } catch (error: any) {
                console.error('Error:', error.response?.status, error.response?.statusText)
                if (error.response?.data) {
                    console.error('Response data:', JSON.stringify(error.response.data, null, 2))
                } else {
                    console.error('Error message:', error.message)
                }

                console.error('\nNote: This error might be because:')
                console.error('1. The API server is not running at the specified URL')
                console.error('2. The endpoint does not exist or has a different path')
                console.error('3. Authentication is required but not provided')
                console.error('\nTry with a different base URL using --base-url option')

                process.exit(1)
            }
        }
    } catch (error: any) {
        handleError(error)
    }
}

/**
 * Determines the base URL to use for API calls based on provided URL, spec, or default value
 */
function determineBaseUrl(spec: OpenAPIV3.Document, baseUrlArg?: string): string {
    // Get base URL from spec
    let baseUrl = spec.servers?.[0]?.url

    // If baseUrl contains variables like {scheme}://{host}:{port}/api, replace them with defaults
    if (baseUrl && baseUrl.includes('{')) {
        const serverVars = spec.servers?.[0]?.variables || {}
        Object.entries(serverVars).forEach(([name, value]) => {
            baseUrl = baseUrl?.replace(`{${name}}`, value.default || '')
        })
    }

    // Use provided base URL if specified, or default if none in spec
    return baseUrlArg || baseUrl || 'http://localhost:8080/api'
}

/**
 * Centralized error handling
 */
function handleError(error: any) {
    console.error('Error:', error.message)
    process.exit(1)
}

main().catch(error => {
    console.error('Error:', error.message)
    process.exit(1)
})