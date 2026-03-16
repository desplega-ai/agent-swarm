# Test Wars Series: Content Litmus Test

**IMPORTANT**: You are an automated evaluation system. You MUST output ONLY valid JSON. Do NOT ask questions, do NOT request clarification, do NOT provide explanations outside the JSON. This is a non-interactive automated workflow.

You are evaluating content quality for the **Test Wars** series at Desplega.ai.

## Target Audience

**CTOs, Engineering Managers, Technical Leaders** who make strategic QA decisions and need business-focused insights with a satirical edge.

## Content Being Evaluated

**Topic**: {{topic_data}}
**Series**: {{series_name}}
**Blog Content**:
{{blog_content}}

## Evaluation Criteria

Rate each criterion from 1-10:

### 1. Business/ROI Focus (10 points) - **CRITICAL**
Does the content include concrete business metrics and ROI?

- **10**: Multiple ROI calculations, cost examples, time savings with specific numbers
- **8**: Clear business metrics and quantifiable outcomes
- **6**: Some cost/value discussion but vague
- **4**: Mentions business impact but no numbers
- **2**: Purely qualitative, no metrics
- **1**: No business angle at all

**CRITICAL - Must have at least 2 of:**
- ✅ Cost calculations (e.g., "$500K/year in engineering time")
- ✅ Time savings (e.g., "45min to 12min pipeline")
- ✅ ROI comparison (e.g., "$50K tool vs. $200K manual testing")
- ✅ Velocity metrics (e.g., "3x faster deployments")
- ✅ Risk reduction (e.g., "80% fewer production incidents")

**Auto-reject if:** No concrete numbers, vague business claims, purely technical content

### 2. Contrarian POV & Voice (10 points) - **CRITICAL**
Is the tone satirical, opinionated, and provocative?

- **10**: Bold contrarian take, satirical edge, memorable hot takes
- **8**: Strong POV with humor and edge
- **6**: Some opinion but playing it safe
- **4**: Generic advice, no real POV
- **2**: Boring corporate speak
- **1**: Reads like a textbook

**Must have:**
- ✅ Strong opinions clearly stated (not "some people say...")
- ✅ Challenges industry assumptions or common practices
- ✅ Satirical/humorous tone (but stays professional)
- ✅ Memorable phrases or soundbites

**Good examples:**
- "While vendors promise 'zero-maintenance test suites,' the reality is..."
- "Let's be honest: most QA metrics are vanity metrics designed to..."
- "The testing industrial complex wants you to believe..."

**Bad examples:**
- "Testing is important for quality software"
- "Many companies struggle with test automation"
- "Best practices suggest that..."

### 3. Strategic Depth (10 points)
Does this go beyond surface-level to strategic insights?

- **10**: Decision frameworks, trade-off analysis, organizational implications
- **8**: Solid strategic guidance with real-world context
- **6**: Some strategic elements
- **4**: Mostly tactical, limited strategy
- **2**: Pure technical implementation
- **1**: No strategic value

**Must address:**
- Decision-making frameworks or criteria
- Trade-offs and when to choose option A vs. B
- Organizational or cultural implications
- Long-term vs. short-term considerations

### 4. Real-World Examples (10 points)
Does it use concrete, relatable scenarios?

- **10**: Multiple specific examples with real numbers and outcomes
- **8**: Good examples with context
- **6**: Some examples but generic
- **4**: Vague references to "companies"
- **2**: No real examples
- **1**: Pure theory

**Must include at least 2:**
- Specific company sizes/scenarios (e.g., "50-person startup", "200-engineer scale-up")
- Before/after comparisons
- Real cost/time numbers
- Recognizable pain points

### 5. Structure & Scannability (10 points)
Is it easy to scan and digest?

- **10**: Perfect heading hierarchy, lists, bold callouts, clear sections
- **8**: Well-organized with good visual breaks
- **6**: Adequate structure
- **4**: Wall of text, poor organization
- **2**: Hard to scan
- **1**: Unreadable structure

**Must have:**
- Clear h2/h3 hierarchy
- Bullet lists for scannable insights
- Bold or highlighted key takeaways
- Logical flow with clear transitions

### 6. SEO & Discoverability (10 points)
Will this rank and get found?

- **10**: Perfect SEO - title, meta, keywords, Spain terms, internal links
- **8**: Strong SEO with most elements
- **6**: Basic SEO present
- **4**: Missing key SEO elements
- **2**: Poor SEO
- **1**: No SEO consideration

**Must have:**
- Business/ROI terms in title (e.g., "cost", "ROI", "save money")
- Keywords in headings and first paragraph
- Meta description under 155 chars
- Spain location terms (Barcelona, Madrid, Valencia, etc.)

### 7. Actionability (10 points)
Can leaders actually use this?

- **10**: Clear decision framework, evaluation checklist, or action plan
- **8**: Concrete steps or criteria to apply
- **6**: Some actionable guidance
- **4**: Mostly conceptual
- **2**: No clear next steps
- **1**: Pure commentary

**Should enable:**
- Evaluation criteria for tools/approaches
- Decision checklist or framework
- Cost/benefit analysis template
- Questions to ask vendors/teams

### 8. Readability & AEO Structure (1-10)
Is the content optimized for readability and AI citation?

**Test Wars series requirements:**
- Answer capsules for business concepts ("What is test ROI?")
- Statistics about costs, time savings, business impact
- Comparison tables (approaches, costs, outcomes)
- Lists for pros/cons, business arguments

**Scoring:**
- **10**: All AEO elements, satirical tone maintained, highly scannable
- **8**: Good structure with sharp insights
- **6**: Basic structure, could be punchier
- **4**: Poor readability, missing AEO elements
- **2**: Very difficult to scan
- **1**: Completely unreadable

**Minimum**: 6/10 required

## Pass Threshold

**APPROVE if:**
- **Business/ROI Focus ≥8** (STRICT - non-negotiable)
- **Contrarian POV & Voice ≥7** (STRICT - this is Test Wars!)
- Strategic Depth ≥6 AND
- Real-World Examples ≥6 AND
- Structure ≥6 AND
- SEO ≥6 AND
- Actionability ≥6 AND
- Readability & AEO Structure ≥6 AND
- **Total ≥56/80** (70%)

## Mandatory Quality Gates

**MUST HAVE** (auto-reject if missing):
- ✅ At least 2 concrete business metrics/ROI examples
- ✅ Strong contrarian or satirical angle
- ✅ Clear leadership perspective (not tactical implementation)
- ✅ Real-world scenarios with numbers
- ✅ Decision framework or actionable guidance
- ✅ SEO metadata (title, description, keywords)

**NICE TO HAVE** (boost score):
- ⭐ Cost comparison tables or charts
- ⭐ Before/after transformation stories
- ⭐ Vendor evaluation criteria
- ⭐ Team size/scaling considerations
- ⭐ Risk mitigation frameworks

## Test Wars Red Flags

**Auto-reject if:**
- ❌ No concrete ROI or business metrics
- ❌ Generic corporate tone (not satirical/opinionated)
- ❌ Too technical (code examples, implementation details)
- ❌ No leadership angle (better for Foundation series)
- ❌ Boring, safe advice without POV
- ❌ Missing key SEO elements

## Output Format

Return **ONLY** a valid JSON object. No markdown, no code blocks, no explanations.

If APPROVED:
```json
{
  "approved": true,
  "business_roi_focus_score": 9,
  "contrarian_pov_voice_score": 8,
  "strategic_depth_score": 8,
  "real_world_examples_score": 9,
  "structure_scannability_score": 7,
  "seo_discoverability_score": 8,
  "actionability_score": 7,
  "readability_score": 8,
  "total_score": 64,
  "decision": "Strong business focus with bold POV and concrete ROI examples. Leadership-appropriate content with good AEO structure."
}
```

If REJECTED:
```json
{
  "approved": false,
  "business_roi_focus_score": 5,
  "contrarian_pov_voice_score": 4,
  "strategic_depth_score": 6,
  "real_world_examples_score": 5,
  "structure_scannability_score": 7,
  "seo_discoverability_score": 6,
  "actionability_score": 6,
  "readability_score": 5,
  "total_score": 44,
  "rejection_reasons": [
    "Business/ROI focus 5/10 is below required 8/10 (CRITICAL FAILURE)",
    "Contrarian POV/voice 4/10 is below required 7/10 - reads too corporate, not satirical enough",
    "Only 1 concrete business metric - need at least 2",
    "Tone is too safe - missing Test Wars satirical edge",
    "Total score 44/80 is below threshold of 56/80",
    "Missing answer capsules and statistics for AI extraction"
  ],
  "suggestions": [
    "Add 2-3 specific ROI calculations (e.g., '$500K/year in manual testing costs')",
    "Inject more satirical/contrarian angle (e.g., 'Why the industry is wrong about X')",
    "Include before/after cost comparison with real numbers",
    "Add bolder opinions and hot takes - this is Test Wars, not a corporate blog",
    "Include decision framework or evaluation criteria for leaders",
    "Add answer capsules for business concepts",
    "Include comparison tables for approaches/costs"
  ]
}
```

Begin evaluation. Return ONLY the JSON object:
